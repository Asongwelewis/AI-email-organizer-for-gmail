import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../src/database/prisma.js';
import { connectedGoogleAccountRepository } from '../src/repositories/connected-google-account.repository.js';
import { OAuthStateRepository } from '../src/repositories/oauth-state.repository.js';
import { SessionRepository } from '../src/repositories/session.repository.js';
import { UserRepository } from '../src/repositories/user.repository.js';
import { sha256 } from '../src/security/hashing.service.js';

const databaseUrl = new URL(process.env['DATABASE_URL'] ?? 'postgresql://localhost/test');
const isDisposableHost = ['127.0.0.1', 'localhost', '::1'].includes(databaseUrl.hostname);
const databaseTests =
  process.env['RUN_DATABASE_INTEGRATION'] === 'true' && isDisposableHost ? describe : describe.skip;

async function cleanDatabase() {
  await prisma.automation_message_actions.deleteMany();
  await prisma.learned_classification_patterns.deleteMany();
  await prisma.automation_runs.deleteMany();
  await prisma.automation_states.deleteMany();
  await prisma.automation_settings.deleteMany();
  await prisma.dynamic_label_candidate_messages.deleteMany();
  await prisma.dynamic_label_candidates.deleteMany();
  await prisma.gmail_sync_runs.deleteMany();
  await prisma.gmail_message_metadata.deleteMany();
  await prisma.gmail_labels.deleteMany();
  await prisma.gmail_sync_states.deleteMany();
  await prisma.audit_logs.deleteMany();
  await prisma.oauth_states.deleteMany();
  await prisma.connected_google_accounts.deleteMany();
  await prisma.sessions.deleteMany();
  await prisma.users.deleteMany();
}

databaseTests('PostgreSQL authentication repositories', () => {
  beforeAll(async () => {
    await prisma.$connect();
  }, 30_000);

  beforeEach(cleanDatabase);

  afterAll(async () => {
    await cleanDatabase();
    await prisma.$disconnect();
  }, 30_000);

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

  it('marks tutorial completion idempotently for a newly created account', async () => {
    const user = await prisma.users.create({
      data: {
        google_subject: `tutorial-${randomUUID()}`,
        email: 'tutorial@example.com',
        normalized_email: 'tutorial@example.com',
      },
    });
    expect(user.tutorial_completed_at).toBeNull();

    const repository = new UserRepository();
    const completedAt = new Date();
    const firstCompletion = await repository.completeTutorial(user.id, completedAt);
    const repeatedCompletion = await repository.completeTutorial(
      user.id,
      new Date(completedAt.getTime() + 60_000),
    );
    expect(firstCompletion).toEqual(completedAt);
    expect(repeatedCompletion).toEqual(completedAt);

    await expect(prisma.users.findUniqueOrThrow({ where: { id: user.id } })).resolves.toMatchObject(
      {
        tutorial_completed_at: completedAt,
      },
    );
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
    await Promise.all([
      connectedGoogleAccountRepository.replaceActiveForUser(user.id, 'first-gmail-subject', {
        email: 'first@gmail.com',
        connection_status: 'CONNECTED',
        gmail_connected: true,
        granted_scopes: ['https://www.googleapis.com/auth/gmail.modify'],
        refresh_token_ciphertext: 'encrypted-refresh',
        refresh_token_iv: 'encrypted-iv',
        refresh_token_auth_tag: 'encrypted-tag',
        encryption_key_version: 1,
      }),
      connectedGoogleAccountRepository.replaceActiveForUser(user.id, 'second-gmail-subject', {
        email: 'second@gmail.com',
        connection_status: 'CONNECTED',
        gmail_connected: true,
        granted_scopes: ['https://www.googleapis.com/auth/gmail.modify'],
        refresh_token_ciphertext: 'new-encrypted-refresh',
        refresh_token_iv: 'new-encrypted-iv',
        refresh_token_auth_tag: 'new-encrypted-tag',
        encryption_key_version: 1,
      }),
    ]);
    const accounts = await prisma.connected_google_accounts.findMany({
      where: { user_id: user.id },
      orderBy: { email: 'asc' },
    });
    expect(accounts).toHaveLength(2);
    expect(accounts.filter((account) => account.gmail_connected)).toHaveLength(1);
    const active = accounts.find((account) => account.gmail_connected);
    const previous = accounts.find((account) => account.id !== active?.id);
    expect(previous).toMatchObject({
      connection_status: 'DISCONNECTED',
      gmail_connected: false,
      refresh_token_ciphertext: null,
      refresh_token_iv: null,
      refresh_token_auth_tag: null,
    });
    await expect(connectedGoogleAccountRepository.findForUser(user.id)).resolves.toMatchObject({
      gmail_connected: true,
    });
  });

  it('uses the callback timestamp as created_at for a newly connected Gmail account', async () => {
    const user = await prisma.users.create({
      data: {
        google_subject: `subject-${randomUUID()}`,
        email: 'callback-timestamp@example.com',
        normalized_email: 'callback-timestamp@example.com',
        email_verified: true,
      },
    });
    const callbackTimestamp = new Date(Date.now() - 1_000);

    const account = await connectedGoogleAccountRepository.replaceActiveForUser(
      user.id,
      'callback-timestamp-gmail-subject',
      {
        email: 'callback-timestamp@gmail.com',
        connection_status: 'CONNECTED',
        gmail_connected: true,
        granted_scopes: ['https://www.googleapis.com/auth/gmail.modify'],
        connected_at: callbackTimestamp,
      },
    );

    expect(account.created_at).toEqual(callbackTimestamp);
    expect(account.connected_at).toEqual(callbackTimestamp);
  });

  it('allows only one active Gmail sync lease and recovers an expired lease', async () => {
    const user = await prisma.users.create({
      data: {
        google_subject: `subject-${randomUUID()}`,
        email: 'sync@example.com',
        normalized_email: 'sync@example.com',
        email_verified: true,
      },
    });
    const account = await prisma.connected_google_accounts.create({
      data: {
        user_id: user.id,
        google_subject: 'sync-google-subject',
        email: 'sync@gmail.com',
        gmail_connected: true,
        connection_status: 'CONNECTED',
      },
    });
    const { GmailRepository } = await import('../src/integrations/gmail/gmail.repository.js');
    const repository = new GmailRepository();
    const results = await Promise.allSettled([
      repository.acquireLease(account.id, 'INITIAL_SYNC_RUNNING', 'INITIAL'),
      repository.acquireLease(account.id, 'INITIAL_SYNC_RUNNING', 'INITIAL'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await prisma.gmail_sync_states.update({
      where: { connected_google_account_id: account.id },
      data: { lease_expires_at: new Date(Date.now() - 1000) },
    });
    await expect(
      repository.acquireLease(account.id, 'INCREMENTAL_SYNC_RUNNING', 'INCREMENTAL'),
    ).resolves.toMatchObject({ accountId: account.id });
  });

  it('cascades Gmail metadata when a connected account is removed', async () => {
    const user = await prisma.users.create({
      data: {
        google_subject: `subject-${randomUUID()}`,
        email: 'cascade@example.com',
        normalized_email: 'cascade@example.com',
        email_verified: true,
      },
    });
    const account = await prisma.connected_google_accounts.create({
      data: {
        user_id: user.id,
        google_subject: 'cascade-google-subject',
        email: 'cascade@gmail.com',
      },
    });
    await prisma.gmail_sync_states.create({
      data: { connected_google_account_id: account.id },
    });
    await prisma.gmail_message_metadata.create({
      data: {
        connected_google_account_id: account.id,
        gmail_message_id: 'message-cascade',
      },
    });
    await prisma.connected_google_accounts.delete({ where: { id: account.id } });
    expect(await prisma.gmail_sync_states.count()).toBe(0);
    expect(await prisma.gmail_message_metadata.count()).toBe(0);
  });

  it('upserts repeated Gmail message ids idempotently within an account', async () => {
    const user = await prisma.users.create({
      data: {
        google_subject: `subject-${randomUUID()}`,
        email: 'idempotent-sync@example.com',
        normalized_email: 'idempotent-sync@example.com',
        email_verified: true,
      },
    });
    const account = await prisma.connected_google_accounts.create({
      data: {
        user_id: user.id,
        google_subject: 'idempotent-sync-google-subject',
        email: 'idempotent-sync@gmail.com',
        gmail_connected: true,
        connection_status: 'CONNECTED',
      },
    });
    const { GmailRepository } = await import('../src/integrations/gmail/gmail.repository.js');
    const repository = new GmailRepository();
    const record = {
      gmail_message_id: 'stable-gmail-id',
      gmail_thread_id: 'thread-id',
      history_id: '100',
      internal_date: new Date('2026-07-26T00:00:00.000Z'),
      subject: 'Original subject',
      sender_name: 'Sender',
      sender_email: 'sender@example.com',
      recipient_summary: 'owner@example.com',
      snippet: 'Metadata only',
      label_ids: ['INBOX'],
      has_attachments: false,
      size_estimate: 100,
      is_unread: true,
      is_starred: false,
      is_important: false,
      is_draft: false,
      is_sent: false,
      is_trashed: false,
    };

    await repository.upsertMessages(account.id, [record]);
    await repository.upsertMessages(account.id, [
      { ...record, history_id: '101', subject: 'Updated subject' },
    ]);

    expect(
      await prisma.gmail_message_metadata.count({
        where: { connected_google_account_id: account.id, gmail_message_id: 'stable-gmail-id' },
      }),
    ).toBe(1);
    await expect(
      prisma.gmail_message_metadata.findUniqueOrThrow({
        where: {
          connected_google_account_id_gmail_message_id: {
            connected_google_account_id: account.id,
            gmail_message_id: 'stable-gmail-id',
          },
        },
      }),
    ).resolves.toMatchObject({ history_id: '101', subject: 'Updated subject' });
  });

  it('persists label discovery candidates and their message associations', async () => {
    const user = await prisma.users.create({
      data: {
        google_subject: `subject-${randomUUID()}`,
        email: 'labels@example.com',
        normalized_email: 'labels@example.com',
        email_verified: true,
      },
    });
    const account = await prisma.connected_google_accounts.create({
      data: {
        user_id: user.id,
        google_subject: 'labels-google-subject',
        email: 'labels@gmail.com',
        gmail_connected: true,
        connection_status: 'CONNECTED',
      },
    });
    const message = await prisma.gmail_message_metadata.create({
      data: {
        connected_google_account_id: account.id,
        gmail_message_id: 'labels-message',
      },
    });
    const candidate = await prisma.dynamic_label_candidates.create({
      data: {
        connected_google_account_id: account.id,
        candidate_type: 'SOURCE',
        source_key: 'github.com',
        suggested_leaf_name: 'GitHub',
        suggested_full_path: 'MailMind/Sources/GitHub',
        normalized_name: 'github',
        confidence: 0.9,
        message_count: 1,
        thread_count: 1,
        category_agreement: 1,
        source_agreement: 1,
        discovery_version: 'mailmind-label-discovery-v1',
        naming_version: 'mailmind-label-naming-v1',
        input_hash: 'b'.repeat(64),
      },
    });
    await prisma.dynamic_label_candidate_messages.create({
      data: {
        candidate_id: candidate.id,
        gmail_message_id: message.id,
        association_score: 0.9,
      },
    });
    await prisma.connected_google_accounts.delete({ where: { id: account.id } });
    expect(await prisma.dynamic_label_candidates.count()).toBe(0);
    expect(await prisma.dynamic_label_candidate_messages.count()).toBe(0);
  });

  it('rejects cross-account label associations and merge cycles', async () => {
    const user = await prisma.users.create({
      data: {
        google_subject: `subject-${randomUUID()}`,
        email: 'merge@example.com',
        normalized_email: 'merge@example.com',
      },
    });
    const [accountA, accountB] = await Promise.all([
      prisma.connected_google_accounts.create({
        data: {
          user_id: user.id,
          google_subject: 'merge-account-a',
          email: 'merge-a@gmail.com',
        },
      }),
      prisma.connected_google_accounts.create({
        data: {
          user_id: user.id,
          google_subject: 'merge-account-b',
          email: 'merge-b@gmail.com',
        },
      }),
    ]);
    const messageB = await prisma.gmail_message_metadata.create({
      data: {
        connected_google_account_id: accountB.id,
        gmail_message_id: 'cross-account-message',
      },
    });
    const base = {
      confidence: 0.8,
      message_count: 3,
      thread_count: 2,
      category_agreement: 1,
      source_agreement: 1,
      discovery_version: 'mailmind-label-discovery-v1',
      naming_version: 'mailmind-label-naming-v1',
    };
    const first = await prisma.dynamic_label_candidates.create({
      data: {
        ...base,
        connected_google_account_id: accountA.id,
        candidate_type: 'SOURCE',
        source_key: 'first.example',
        suggested_leaf_name: 'First Source',
        suggested_full_path: 'MailMind/Sources/First Source',
        normalized_name: 'firstsource',
        input_hash: 'c'.repeat(64),
      },
    });
    const second = await prisma.dynamic_label_candidates.create({
      data: {
        ...base,
        connected_google_account_id: accountA.id,
        candidate_type: 'SOURCE',
        source_key: 'second.example',
        suggested_leaf_name: 'Second Source',
        suggested_full_path: 'MailMind/Sources/Second Source',
        normalized_name: 'secondsource',
        input_hash: 'd'.repeat(64),
      },
    });
    await expect(
      prisma.dynamic_label_candidate_messages.create({
        data: {
          candidate_id: first.id,
          gmail_message_id: messageB.id,
          association_score: 0.8,
        },
      }),
    ).rejects.toThrow();
    await prisma.dynamic_label_candidates.update({
      where: { id: first.id },
      data: { status: 'MERGED', merged_into_candidate_id: second.id },
    });
    await expect(
      prisma.dynamic_label_candidates.update({
        where: { id: second.id },
        data: { status: 'MERGED', merged_into_candidate_id: first.id },
      }),
    ).rejects.toThrow();
  });

  it('enforces one durable automation action per message and persists bounded usage', async () => {
    const user = await prisma.users.create({
      data: {
        google_subject: `subject-${randomUUID()}`,
        email: 'automation@example.com',
        normalized_email: 'automation@example.com',
      },
    });
    const account = await prisma.connected_google_accounts.create({
      data: {
        user_id: user.id,
        google_subject: 'automation-google-subject',
        email: 'automation@gmail.com',
        gmail_connected: true,
        connection_status: 'CONNECTED',
      },
    });
    const message = await prisma.gmail_message_metadata.create({
      data: {
        connected_google_account_id: account.id,
        gmail_message_id: 'automation-message',
      },
    });
    const run = await prisma.automation_runs.create({
      data: {
        connected_google_account_id: account.id,
        idempotency_key: `manual:${randomUUID()}`,
        trigger: 'MANUAL',
        input_tokens: 100,
        output_tokens: 20,
        estimated_cost_microusd: 1100,
        last_provider_status: 429,
        last_provider_code: 'insufficient_quota',
        last_provider_request_id: 'request-safe-id',
      },
    });
    const actionData = {
      automation_run_id: run.id,
      connected_google_account_id: account.id,
      gmail_message_id: message.id,
      user_id: user.id,
      category: 'WORK' as const,
      label_path: 'MailMind/Work',
      confidence: 0.9,
      source: 'OPENAI' as const,
      explanation: 'Work metadata.',
      input_hash: 'e'.repeat(64),
    };
    await prisma.automation_message_actions.create({ data: actionData });
    await expect(prisma.automation_message_actions.create({ data: actionData })).rejects.toThrow();
    expect(await prisma.automation_runs.findUnique({ where: { id: run.id } })).toMatchObject({
      input_tokens: 100,
      output_tokens: 20,
      estimated_cost_microusd: 1100,
      last_provider_status: 429,
      last_provider_code: 'insufficient_quota',
      last_provider_request_id: 'request-safe-id',
    });
  });
});
