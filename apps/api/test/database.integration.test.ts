import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../src/database/prisma.js';
import { connectedGoogleAccountRepository } from '../src/repositories/connected-google-account.repository.js';
import { OAuthStateRepository } from '../src/repositories/oauth-state.repository.js';
import { SessionRepository } from '../src/repositories/session.repository.js';
import { UserRepository } from '../src/repositories/user.repository.js';
import { sha256 } from '../src/security/hashing.service.js';

const databaseTests = process.env['RUN_DATABASE_INTEGRATION'] === 'true' ? describe : describe.skip;

async function cleanDatabase() {
  await prisma.audit_logs.deleteMany();
  await prisma.oauth_states.deleteMany();
  await prisma.connected_google_accounts.deleteMany();
  await prisma.sessions.deleteMany();
  await prisma.users.deleteMany();
}

databaseTests('PostgreSQL authentication repositories', () => {
  beforeEach(cleanDatabase);

  it('atomically creates one user and a hashed session, then updates by stable Google subject', async () => {
    const repository = new UserRepository();
    const subject = `subject-${randomUUID()}`;
    const first = await repository.upsertGoogleIdentityAndCreateSession(
      {
        googleSubject: subject,
        email: 'first@example.com',
        displayName: 'First Name',
        avatarUrl: null,
        emailVerified: true,
      },
      {
        session_token_hash: sha256('first-raw-session-token'),
        expires_at: new Date(Date.now() + 60_000),
      },
    );
    const second = await repository.upsertGoogleIdentityAndCreateSession(
      {
        googleSubject: subject,
        email: 'changed@example.com',
        displayName: 'Changed Name',
        avatarUrl: null,
        emailVerified: true,
      },
      {
        session_token_hash: sha256('second-raw-session-token'),
        expires_at: new Date(Date.now() + 60_000),
      },
    );
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.email).toBe('changed@example.com');
    expect(await prisma.users.count()).toBe(1);
    expect(await prisma.sessions.count()).toBe(2);
    const stored = await prisma.sessions.findUniqueOrThrow({ where: { id: first.session.id } });
    expect(stored.session_token_hash).toBe(sha256('first-raw-session-token'));
    expect(stored.session_token_hash).not.toBe('first-raw-session-token');
  });

  it.each(['SUSPENDED', 'DELETED'] as const)(
    'rolls back session creation for a %s user',
    async (status) => {
      const repository = new UserRepository();
      const subject = `subject-${randomUUID()}`;
      const created = await repository.upsertGoogleIdentityAndCreateSession(
        {
          googleSubject: subject,
          email: `${status.toLowerCase()}@example.com`,
          displayName: null,
          avatarUrl: null,
          emailVerified: true,
        },
        {
          session_token_hash: sha256('initial-session'),
          expires_at: new Date(Date.now() + 60_000),
        },
      );
      await prisma.users.update({
        where: { id: created.user.id },
        data: {
          status,
          ...(status === 'DELETED' ? { deleted_at: new Date() } : {}),
        },
      });
      await expect(
        repository.upsertGoogleIdentityAndCreateSession(
          {
            googleSubject: subject,
            email: `${status.toLowerCase()}@example.com`,
            displayName: null,
            avatarUrl: null,
            emailVerified: true,
          },
          {
            session_token_hash: sha256(`forbidden-${status}`),
            expires_at: new Date(Date.now() + 60_000),
          },
        ),
      ).rejects.toMatchObject({
        code: status === 'SUSPENDED' ? 'AUTH_USER_SUSPENDED' : 'AUTH_USER_DELETED',
      });
      expect(await prisma.sessions.count({ where: { user_id: created.user.id } })).toBe(1);
    },
  );

  it('allows only one concurrent OAuth-state consumer', async () => {
    const repository = new OAuthStateRepository();
    await repository.create({
      state_hash: sha256('raw-oauth-state'),
      purpose: 'LOGIN',
      expires_at: new Date(Date.now() + 60_000),
    });
    const results = await Promise.allSettled([
      repository.consume(sha256('raw-oauth-state'), ['LOGIN']),
      repository.consume(sha256('raw-oauth-state'), ['LOGIN']),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('allows only one concurrent session rotation winner', async () => {
    const user = await prisma.users.create({
      data: {
        google_subject: `subject-${randomUUID()}`,
        email: 'rotate@example.com',
        normalized_email: 'rotate@example.com',
        email_verified: true,
      },
    });
    const original = await prisma.sessions.create({
      data: {
        user_id: user.id,
        session_token_hash: sha256('original-token'),
        expires_at: new Date(Date.now() + 60_000),
      },
    });
    const repository = new SessionRepository();
    const results = await Promise.all([
      repository.rotate(original.id, sha256('replacement-one'), new Date(Date.now() + 60_000)),
      repository.rotate(original.id, sha256('replacement-two'), new Date(Date.now() + 60_000)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await prisma.sessions.count({ where: { user_id: user.id, revoked_at: null } })).toBe(1);
  });

  it('keeps only one active Gmail identity and clears previous token material', async () => {
    const user = await prisma.users.create({
      data: {
        google_subject: `subject-${randomUUID()}`,
        email: 'connections@example.com',
        normalized_email: 'connections@example.com',
        email_verified: true,
      },
    });
    await connectedGoogleAccountRepository.replaceActiveForUser(user.id, 'first-gmail-subject', {
      email: 'first@gmail.com',
      connection_status: 'CONNECTED',
      gmail_connected: true,
      granted_scopes: ['https://www.googleapis.com/auth/gmail.modify'],
      refresh_token_ciphertext: 'encrypted-refresh',
      refresh_token_iv: 'encrypted-iv',
      refresh_token_auth_tag: 'encrypted-tag',
      encryption_key_version: 1,
    });
    await connectedGoogleAccountRepository.replaceActiveForUser(user.id, 'second-gmail-subject', {
      email: 'second@gmail.com',
      connection_status: 'CONNECTED',
      gmail_connected: true,
      granted_scopes: ['https://www.googleapis.com/auth/gmail.modify'],
      refresh_token_ciphertext: 'new-encrypted-refresh',
      refresh_token_iv: 'new-encrypted-iv',
      refresh_token_auth_tag: 'new-encrypted-tag',
      encryption_key_version: 1,
    });
    const accounts = await prisma.connected_google_accounts.findMany({
      where: { user_id: user.id },
      orderBy: { email: 'asc' },
    });
    expect(accounts).toHaveLength(2);
    expect(accounts.filter((account) => account.gmail_connected)).toHaveLength(1);
    const previous = accounts.find((account) => account.google_subject === 'first-gmail-subject');
    expect(previous).toMatchObject({
      connection_status: 'DISCONNECTED',
      gmail_connected: false,
      refresh_token_ciphertext: null,
      refresh_token_iv: null,
      refresh_token_auth_tag: null,
    });
    await expect(connectedGoogleAccountRepository.findForUser(user.id)).resolves.toMatchObject({
      google_subject: 'second-gmail-subject',
      gmail_connected: true,
    });
  });
});
