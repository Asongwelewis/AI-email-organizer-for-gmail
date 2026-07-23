import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { connected_google_accounts } from '@prisma/client';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  conditionalTokenUpdate: vi.fn(),
  markReauthenticationRequired: vi.fn(),
  audit: vi.fn(),
  setCredentials: vi.fn(),
  getAccessToken: vi.fn(),
  revokeToken: vi.fn(),
  credentials: {} as { expiry_date?: number },
}));

vi.mock('../src/repositories/connected-google-account.repository.js', () => ({
  connectedGoogleAccountRepository: {
    findById: mocks.findById,
    conditionalTokenUpdate: mocks.conditionalTokenUpdate,
    markReauthenticationRequired: mocks.markReauthenticationRequired,
  },
}));
vi.mock('../src/audit/audit.service.js', () => ({ auditService: { record: mocks.audit } }));
vi.mock('../src/integrations/google/google-oauth.client.js', () => ({
  createGoogleOAuthClient: () => ({
    credentials: mocks.credentials,
    setCredentials: mocks.setCredentials,
    getAccessToken: mocks.getAccessToken,
    revokeToken: mocks.revokeToken,
  }),
}));

import { encryptionService } from '../src/security/encryption.service.js';
import { GoogleTokenService } from '../src/integrations/google/google-token.service.js';

function connectedAccount(overrides: Record<string, unknown> = {}): connected_google_accounts {
  const access = encryptionService.encrypt('current-access-token');
  const refresh = encryptionService.encrypt('current-refresh-token');
  return {
    id: 'account-id',
    user_id: 'user-id',
    connection_status: 'CONNECTED',
    access_token_ciphertext: access.ciphertext,
    access_token_iv: access.iv,
    access_token_auth_tag: access.authTag,
    refresh_token_ciphertext: refresh.ciphertext,
    refresh_token_iv: refresh.iv,
    refresh_token_auth_tag: refresh.authTag,
    encryption_key_version: access.keyVersion,
    access_token_expires_at: new Date(Date.now() + 10 * 60_000),
    ...overrides,
  } as unknown as connected_google_accounts;
}

describe('GoogleTokenService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.credentials.expiry_date = Date.now() + 60 * 60_000;
    mocks.audit.mockResolvedValue(undefined);
    mocks.markReauthenticationRequired.mockResolvedValue({});
  });

  it('returns a decrypted non-expired access token without refreshing', async () => {
    mocks.findById.mockResolvedValue(connectedAccount());
    await expect(
      new GoogleTokenService().getValidAccessTokenForConnectedAccount('account-id'),
    ).resolves.toBe('current-access-token');
    expect(mocks.getAccessToken).not.toHaveBeenCalled();
  });

  it('refreshes an expiring token and persists only encrypted material', async () => {
    mocks.findById.mockResolvedValue(
      connectedAccount({ access_token_expires_at: new Date(Date.now() - 1) }),
    );
    mocks.getAccessToken.mockResolvedValue({ token: 'new-plaintext-access-token' });
    mocks.conditionalTokenUpdate.mockResolvedValue({ count: 1 });
    await expect(
      new GoogleTokenService().getValidAccessTokenForConnectedAccount('account-id'),
    ).resolves.toBe('new-plaintext-access-token');
    const persisted = mocks.conditionalTokenUpdate.mock.calls[0]?.[2];
    expect(JSON.stringify(persisted)).not.toContain('new-plaintext-access-token');
    expect(persisted.access_token_ciphertext).toBeTruthy();
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'GOOGLE_TOKEN_REFRESHED' }),
    );
  });

  it('reloads the database winner when concurrent refresh persistence loses', async () => {
    const expired = connectedAccount({ access_token_expires_at: new Date(0) });
    const winnerToken = encryptionService.encrypt('winner-access-token');
    mocks.findById.mockResolvedValueOnce(expired).mockResolvedValueOnce({
      ...expired,
      access_token_ciphertext: winnerToken.ciphertext,
      access_token_iv: winnerToken.iv,
      access_token_auth_tag: winnerToken.authTag,
      encryption_key_version: winnerToken.keyVersion,
    });
    mocks.getAccessToken.mockResolvedValue({ token: 'losing-access-token' });
    mocks.conditionalTokenUpdate.mockResolvedValue({ count: 0 });
    await expect(
      new GoogleTokenService().getValidAccessTokenForConnectedAccount('account-id'),
    ).resolves.toBe('winner-access-token');
  });

  it('marks the connection REAUTH_REQUIRED for missing or revoked refresh credentials', async () => {
    const noRefresh = connectedAccount({
      access_token_expires_at: new Date(0),
      refresh_token_ciphertext: null,
      refresh_token_iv: null,
      refresh_token_auth_tag: null,
    });
    mocks.findById.mockResolvedValueOnce(noRefresh);
    await expect(
      new GoogleTokenService().getValidAccessTokenForConnectedAccount('account-id'),
    ).rejects.toMatchObject({ code: 'GMAIL_REAUTH_REQUIRED' });
    expect(mocks.markReauthenticationRequired).toHaveBeenCalledWith(
      'account-id',
      'MISSING_REFRESH_TOKEN',
    );

    mocks.findById.mockResolvedValueOnce(
      connectedAccount({ access_token_expires_at: new Date(0) }),
    );
    mocks.getAccessToken.mockRejectedValueOnce(new Error('invalid_grant'));
    await expect(
      new GoogleTokenService().getValidAccessTokenForConnectedAccount('account-id'),
    ).rejects.toMatchObject({ code: 'GMAIL_REAUTH_REQUIRED' });
    expect(mocks.markReauthenticationRequired).toHaveBeenCalledWith(
      'account-id',
      'GOOGLE_CREDENTIALS_INVALID',
    );
  });

  it('treats already-revoked Google credentials as a successful local revocation attempt', async () => {
    mocks.revokeToken.mockRejectedValue(new Error('already revoked'));
    await expect(
      new GoogleTokenService().revokeGoogleCredentials(connectedAccount()),
    ).resolves.toBeUndefined();
  });
});
