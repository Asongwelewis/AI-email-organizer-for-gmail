import type { connected_google_accounts } from '@prisma/client';

import { auditService } from '@api/audit/audit.service.js';
import { AppError } from '@api/errors/AppError.js';
import { connectedGoogleAccountRepository } from '@api/repositories/connected-google-account.repository.js';
import { encryptionService, type EncryptedValue } from '@api/security/encryption.service.js';
import { createGoogleOAuthClient } from './google-oauth.client.js';

const EXPIRY_BUFFER_MS = 2 * 60 * 1000;

function encryptedFromAccount(
  account: connected_google_accounts,
  type: 'access' | 'refresh',
): EncryptedValue | null {
  const ciphertext =
    type === 'access' ? account.access_token_ciphertext : account.refresh_token_ciphertext;
  const iv = type === 'access' ? account.access_token_iv : account.refresh_token_iv;
  const authTag =
    type === 'access' ? account.access_token_auth_tag : account.refresh_token_auth_tag;
  if (!ciphertext || !iv || !authTag || !account.encryption_key_version) return null;
  return { ciphertext, iv, authTag, keyVersion: account.encryption_key_version };
}

export class GoogleTokenService {
  async getValidAccessTokenForConnectedAccount(accountId: string): Promise<string> {
    const account = await connectedGoogleAccountRepository.findById(accountId);
    if (!account || account.connection_status !== 'CONNECTED') {
      throw new AppError('GMAIL_REAUTH_REQUIRED', 'Reconnect Gmail to continue.', 409);
    }
    const access = encryptedFromAccount(account, 'access');
    if (
      access &&
      account.access_token_expires_at &&
      account.access_token_expires_at.getTime() > Date.now() + EXPIRY_BUFFER_MS
    ) {
      return encryptionService.decrypt(access);
    }
    return this.refreshGoogleAccessToken(account);
  }

  async refreshGoogleAccessToken(account: connected_google_accounts): Promise<string> {
    const refresh = encryptedFromAccount(account, 'refresh');
    if (!refresh) {
      await connectedGoogleAccountRepository.markReauthenticationRequired(
        account.id,
        'MISSING_REFRESH_TOKEN',
      );
      throw new AppError('GMAIL_REAUTH_REQUIRED', 'Reconnect Gmail to continue.', 409);
    }
    try {
      const client = createGoogleOAuthClient('GMAIL');
      client.setCredentials({ refresh_token: encryptionService.decrypt(refresh) });
      const response = await client.getAccessToken();
      if (!response.token) throw new Error('no access token returned');
      const encrypted = encryptionService.encrypt(response.token);
      const expiry = client.credentials.expiry_date
        ? new Date(client.credentials.expiry_date)
        : new Date(Date.now() + 55 * 60 * 1000);
      const updated = await connectedGoogleAccountRepository.conditionalTokenUpdate(
        account.id,
        account.access_token_expires_at,
        {
          access_token_ciphertext: encrypted.ciphertext,
          access_token_iv: encrypted.iv,
          access_token_auth_tag: encrypted.authTag,
          encryption_key_version: encrypted.keyVersion,
          access_token_expires_at: expiry,
          last_token_refresh_at: new Date(),
          last_connection_error_code: null,
          last_connection_error_at: null,
        },
      );
      if (updated.count === 0) {
        const winner = await connectedGoogleAccountRepository.findById(account.id);
        const winnerToken = winner && encryptedFromAccount(winner, 'access');
        if (winnerToken) return encryptionService.decrypt(winnerToken);
      }
      await auditService.record({
        action: 'GOOGLE_TOKEN_REFRESHED',
        result: 'SUCCESS',
        userId: account.user_id,
      });
      return response.token;
    } catch (error) {
      if (error instanceof AppError && error.code === 'INTERNAL_SERVER_ERROR') throw error;
      await connectedGoogleAccountRepository.markReauthenticationRequired(
        account.id,
        'GOOGLE_CREDENTIALS_INVALID',
      );
      await auditService.record({
        action: 'GOOGLE_TOKEN_REFRESH_FAILED',
        result: 'FAILURE',
        userId: account.user_id,
        metadata: { code: 'GOOGLE_CREDENTIALS_INVALID' },
      });
      throw new AppError('GMAIL_REAUTH_REQUIRED', 'Reconnect Gmail to continue.', 409);
    }
  }

  async revokeGoogleCredentials(account: connected_google_accounts): Promise<void> {
    const refresh = encryptedFromAccount(account, 'refresh');
    const access = encryptedFromAccount(account, 'access');
    const credential = refresh ?? access;
    if (!credential) return;
    try {
      await createGoogleOAuthClient('GMAIL').revokeToken(encryptionService.decrypt(credential));
    } catch {
      // Local disconnect is authoritative and remains idempotent if Google already revoked it.
    }
  }
}

export const googleTokenService = new GoogleTokenService();
