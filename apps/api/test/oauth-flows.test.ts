import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  oauthCreate: vi.fn(),
  oauthConsume: vi.fn(),
  audit: vi.fn(),
  generateAuthUrl: vi.fn().mockReturnValue('https://accounts.google.test/auth'),
  getToken: vi.fn(),
  verifyIdentity: vi.fn(),
  findForUser: vi.fn(),
  findByUserAndSubject: vi.fn(),
  replaceActiveForUser: vi.fn(),
  update: vi.fn(),
  revoke: vi.fn(),
  createIdentitySession: vi.fn(),
}));

vi.mock('../src/repositories/oauth-state.repository.js', () => ({
  oauthStateRepository: { create: mocks.oauthCreate, consume: mocks.oauthConsume },
}));
vi.mock('../src/audit/audit.service.js', () => ({ auditService: { record: mocks.audit } }));
vi.mock('../src/integrations/google/google-oauth.client.js', () => ({
  createGoogleOAuthClient: () => ({
    generateAuthUrl: mocks.generateAuthUrl,
    getToken: mocks.getToken,
  }),
}));
vi.mock('../src/integrations/google/google-identity.service.js', () => ({
  verifyGoogleIdentity: mocks.verifyIdentity,
}));
vi.mock('../src/repositories/connected-google-account.repository.js', () => ({
  connectedGoogleAccountRepository: {
    findForUser: mocks.findForUser,
    findByUserAndSubject: mocks.findByUserAndSubject,
    replaceActiveForUser: mocks.replaceActiveForUser,
    update: mocks.update,
  },
}));
vi.mock('../src/integrations/google/google-token.service.js', () => ({
  googleTokenService: { revokeGoogleCredentials: mocks.revoke },
}));
vi.mock('../src/sessions/session.service.js', () => ({
  sessionService: {
    createForGoogleIdentity: mocks.createIdentitySession,
  },
}));

import { AuthService } from '../src/auth/auth.service.js';
import { GMAIL_MODIFY_SCOPE } from '../src/integrations/google/google-scopes.js';
import { GoogleGmailService } from '../src/integrations/google/google-login.service.js';
import { sha256 } from '../src/security/hashing.service.js';
import { AppError } from '../src/errors/AppError.js';

const authRequest = {
  requestId: 'request-id',
  auth: {
    id: 'session-id',
    user: {
      id: 'user-id',
      email: 'login@example.com',
      displayName: null,
      avatarUrl: null,
      status: 'ACTIVE',
    },
  },
} as never;

describe('OAuth start and safe status contracts', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.generateAuthUrl.mockReturnValue('https://accounts.google.test/auth');
    mocks.oauthCreate.mockResolvedValue({});
    mocks.audit.mockResolvedValue(undefined);
    mocks.oauthConsume.mockResolvedValue({
      initiating_user_id: 'user-id',
      initiating_session_id: 'session-id',
      redirect_path: '/settings/connections',
    });
    mocks.verifyIdentity.mockResolvedValue({
      subject: 'gmail-subject',
      email: 'connected@gmail.com',
      emailVerified: true,
      displayName: 'Connected User',
      avatarUrl: null,
    });
    mocks.replaceActiveForUser.mockResolvedValue({});
    mocks.createIdentitySession.mockResolvedValue({
      rawToken: 'raw-session-token',
      session: {
        id: 'created-session-id',
        user: {
          id: 'user-id',
          email: 'connected@gmail.com',
          displayName: 'Connected User',
          avatarUrl: null,
          status: 'ACTIVE',
        },
      },
    });
  });

  it('stores login state only as a hash and excludes Gmail scope', async () => {
    await new AuthService().beginGoogleLogin({ requestId: 'request-id' } as never, '/dashboard');
    const stored = mocks.oauthCreate.mock.calls[0]?.[0];
    const options = mocks.generateAuthUrl.mock.calls[0]?.[0];
    expect(stored.purpose).toBe('LOGIN');
    expect(stored.state_hash).toBe(sha256(options.state));
    expect(stored.state_hash).not.toBe(options.state);
    expect(options.scope).toEqual(['openid', 'email', 'profile']);
    expect(options.scope).not.toContain(GMAIL_MODIFY_SCOPE);
  });

  it('binds Gmail state to the authenticated user/session and requests offline incremental access', async () => {
    mocks.findForUser.mockResolvedValue(null);
    await new GoogleGmailService().beginConnection(authRequest, '/settings/connections');
    const stored = mocks.oauthCreate.mock.calls[0]?.[0];
    const options = mocks.generateAuthUrl.mock.calls[0]?.[0];
    expect(stored).toMatchObject({
      purpose: 'CONNECT_GMAIL',
      initiating_user_id: 'user-id',
      initiating_session_id: 'session-id',
    });
    expect(stored.state_hash).toBe(sha256(options.state));
    expect(options.scope).toContain(GMAIL_MODIFY_SCOPE);
    expect(options.access_type).toBe('offline');
    expect(options.include_granted_scopes).toBe(true);
    expect(options.prompt).toBe('consent');
  });

  it('completes login once, persists the verified identity, and returns no Google token object', async () => {
    mocks.oauthConsume.mockResolvedValueOnce({ redirect_path: '/dashboard' });
    mocks.getToken.mockResolvedValueOnce({ tokens: { id_token: 'mock-id-token' } });
    const result = await new AuthService().completeGoogleLogin(
      { requestId: 'request-id', get: vi.fn(), ip: '127.0.0.1' } as never,
      'authorization-code',
      'oauth-state',
    );
    expect(mocks.oauthConsume).toHaveBeenCalledWith(sha256('oauth-state'), ['LOGIN']);
    expect(mocks.createIdentitySession).toHaveBeenCalledWith(
      expect.objectContaining({
        googleSubject: 'gmail-subject',
        email: 'connected@gmail.com',
        emailVerified: true,
      }),
      expect.anything(),
    );
    expect(result.redirectPath).toBe('/dashboard');
    expect(JSON.stringify(result)).not.toContain('mock-id-token');
    expect(JSON.stringify(result)).not.toContain('authorization-code');
  });

  it('rejects missing parameters and allows a duplicate callback to create only one session', async () => {
    const service = new AuthService();
    await expect(
      service.completeGoogleLogin({ requestId: 'request-id' } as never, undefined, 'state'),
    ).rejects.toMatchObject({ code: 'AUTH_GOOGLE_CALLBACK_FAILED' });
    mocks.oauthConsume
      .mockResolvedValueOnce({ redirect_path: '/dashboard' })
      .mockRejectedValueOnce(
        new AppError('AUTH_OAUTH_STATE_USED', 'The authorization request was already used.', 400),
      );
    mocks.getToken.mockResolvedValue({ tokens: { id_token: 'mock-id-token' } });
    await service.completeGoogleLogin(
      { requestId: 'request-id', get: vi.fn() } as never,
      'code',
      'state',
    );
    await expect(
      service.completeGoogleLogin(
        { requestId: 'request-id', get: vi.fn() } as never,
        'code',
        'state',
      ),
    ).rejects.toMatchObject({ code: 'AUTH_OAUTH_STATE_USED' });
    expect(mocks.createIdentitySession).toHaveBeenCalledOnce();
  });

  it.each(['AUTH_USER_SUSPENDED', 'AUTH_USER_DELETED'] as const)(
    'does not issue a session when persistence reports %s',
    async (code) => {
      mocks.oauthConsume.mockResolvedValueOnce({ redirect_path: '/dashboard' });
      mocks.getToken.mockResolvedValueOnce({ tokens: { id_token: 'mock-id-token' } });
      mocks.createIdentitySession.mockRejectedValueOnce(
        new AppError(
          code,
          code === 'AUTH_USER_SUSPENDED'
            ? 'This account is suspended.'
            : 'This account is unavailable.',
          403,
        ),
      );
      await expect(
        new AuthService().completeGoogleLogin(
          { requestId: 'request-id', get: vi.fn() } as never,
          'code',
          'state',
        ),
      ).rejects.toMatchObject({ code });
    },
  );

  it('consumes login state when Google returns a denial', async () => {
    mocks.oauthConsume.mockResolvedValueOnce({});
    await new AuthService().denyGoogleLogin({ requestId: 'request-id' } as never, 'denied-state');
    expect(mocks.oauthConsume).toHaveBeenCalledWith(sha256('denied-state'), ['LOGIN']);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'AUTH_LOGIN_FAILED', result: 'DENIED' }),
    );
  });

  it('returns Gmail status without any token material', async () => {
    mocks.findForUser.mockResolvedValue({
      email: 'connected@gmail.com',
      gmail_connected: true,
      connection_status: 'CONNECTED',
      granted_scopes: [GMAIL_MODIFY_SCOPE],
      connected_at: new Date('2026-07-20T10:00:00.000Z'),
      updated_at: new Date('2026-07-20T10:00:00.000Z'),
      access_token_ciphertext: 'secret-ciphertext',
      refresh_token_ciphertext: 'secret-refresh',
    });
    const status = await new GoogleGmailService().status('user-id');
    expect(status.connected).toBe(true);
    expect(JSON.stringify(status)).not.toContain('secret-ciphertext');
    expect(JSON.stringify(status)).not.toContain('secret-refresh');
  });

  it('encrypts new tokens and marks a fully authorized Gmail account connected', async () => {
    mocks.findByUserAndSubject.mockResolvedValue(null);
    mocks.getToken.mockResolvedValue({
      tokens: {
        id_token: 'mock-id-token',
        access_token: 'plaintext-access',
        refresh_token: 'plaintext-refresh',
        scope: `openid email ${GMAIL_MODIFY_SCOPE}`,
        expiry_date: Date.now() + 3_600_000,
      },
    });
    const result = await new GoogleGmailService().completeConnection(
      authRequest,
      'authorization-code',
      'raw-state',
    );
    const saved = mocks.replaceActiveForUser.mock.calls[0]?.[2];
    expect(result.status).toBe('gmail_connected');
    expect(saved.connection_status).toBe('CONNECTED');
    expect(saved.gmail_connected).toBe(true);
    expect(saved.access_token_ciphertext).not.toBe('plaintext-access');
    expect(saved.refresh_token_ciphertext).not.toBe('plaintext-refresh');
    expect(JSON.stringify(saved)).not.toContain('plaintext-access');
    expect(JSON.stringify(saved)).not.toContain('plaintext-refresh');
  });

  it('revokes the previous Gmail identity before replacing it', async () => {
    mocks.findByUserAndSubject.mockResolvedValue(null);
    mocks.findForUser.mockResolvedValue({
      id: 'previous-account-id',
      google_subject: 'previous-google-subject',
    });
    mocks.getToken.mockResolvedValue({
      tokens: {
        id_token: 'mock-id-token',
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        scope: GMAIL_MODIFY_SCOPE,
      },
    });
    await new GoogleGmailService().completeConnection(authRequest, 'code', 'state');
    expect(mocks.revoke).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'previous-account-id' }),
    );
    expect(mocks.revoke.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.replaceActiveForUser.mock.invocationCallOrder[0]!,
    );
  });

  it('consumes Gmail state on consent denial without touching the MailMind session', async () => {
    mocks.oauthConsume.mockResolvedValueOnce({
      initiating_user_id: 'user-id',
      initiating_session_id: 'session-id',
    });
    await new GoogleGmailService().denyConnection(authRequest, 'denied-state');
    expect(mocks.oauthConsume).toHaveBeenCalledWith(sha256('denied-state'), [
      'CONNECT_GMAIL',
      'REAUTHORIZE_GMAIL',
    ]);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'GMAIL_CONNECTION_DENIED',
        userId: 'user-id',
        sessionId: 'session-id',
      }),
    );
    expect(mocks.createIdentitySession).not.toHaveBeenCalled();
  });

  it('preserves an existing refresh token when Google omits a new one', async () => {
    mocks.findByUserAndSubject.mockResolvedValue({
      refresh_token_ciphertext: 'preserved-ciphertext',
      refresh_token_iv: 'preserved-iv',
      refresh_token_auth_tag: 'preserved-tag',
      encryption_key_version: 1,
      connected_at: new Date(),
    });
    mocks.getToken.mockResolvedValue({
      tokens: {
        id_token: 'mock-id-token',
        access_token: 'new-access',
        scope: GMAIL_MODIFY_SCOPE,
      },
    });
    await new GoogleGmailService().completeConnection(authRequest, 'code', 'state');
    const saved = mocks.replaceActiveForUser.mock.calls[0]?.[2];
    expect(saved.refresh_token_ciphertext).toBe('preserved-ciphertext');
    expect(saved.refresh_token_iv).toBe('preserved-iv');
    expect(saved.connection_status).toBe('CONNECTED');
  });

  it('requires reauthorization when refresh credentials or Gmail permission are missing', async () => {
    mocks.findByUserAndSubject.mockResolvedValue(null);
    mocks.getToken
      .mockResolvedValueOnce({
        tokens: { id_token: 'mock-id-token', access_token: 'access', scope: GMAIL_MODIFY_SCOPE },
      })
      .mockResolvedValueOnce({
        tokens: {
          id_token: 'mock-id-token',
          access_token: 'access',
          refresh_token: 'refresh',
          scope: 'openid email',
        },
      });
    const missingRefresh = await new GoogleGmailService().completeConnection(
      authRequest,
      'code',
      'state',
    );
    expect(missingRefresh.status).toBe('gmail_reauth_required');
    expect(mocks.replaceActiveForUser.mock.calls[0]?.[2].gmail_connected).toBe(false);
    const missingScope = await new GoogleGmailService().completeConnection(
      authRequest,
      'code',
      'state',
    );
    expect(missingScope.status).toBe('gmail_permission_incomplete');
    expect(mocks.replaceActiveForUser.mock.calls[1]?.[2].connection_status).toBe('REAUTH_REQUIRED');
  });

  it('disconnects idempotently while leaving the MailMind session untouched', async () => {
    mocks.findForUser.mockResolvedValueOnce(null);
    await expect(new GoogleGmailService().disconnect(authRequest)).resolves.toBeUndefined();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it('revokes and clears all Google token fields without revoking MailMind sessions', async () => {
    const account = {
      id: 'account-id',
      user_id: 'user-id',
      connection_status: 'CONNECTED',
      access_token_ciphertext: 'encrypted-access',
      refresh_token_ciphertext: 'encrypted-refresh',
    };
    mocks.findForUser.mockResolvedValue(account);
    mocks.revoke.mockResolvedValue(undefined);
    mocks.update.mockResolvedValue({});
    const service = new GoogleGmailService();
    await service.disconnect(authRequest);
    await service.disconnect(authRequest);
    expect(mocks.revoke).toHaveBeenCalledTimes(2);
    expect(mocks.update).toHaveBeenCalledWith(
      'account-id',
      expect.objectContaining({
        access_token_ciphertext: null,
        access_token_iv: null,
        access_token_auth_tag: null,
        refresh_token_ciphertext: null,
        refresh_token_iv: null,
        refresh_token_auth_tag: null,
        encryption_key_version: null,
        access_token_expires_at: null,
        connection_status: 'DISCONNECTED',
        gmail_connected: false,
      }),
    );
    expect(mocks.createIdentitySession).not.toHaveBeenCalled();
  });
});
