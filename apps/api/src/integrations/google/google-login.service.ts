import type { Request } from 'express';

import { auditService } from '@api/audit/audit.service.js';
import { env } from '@api/config/env.js';
import { AppError } from '@api/errors/AppError.js';
import { connectedGoogleAccountRepository } from '@api/repositories/connected-google-account.repository.js';
import { oauthStateRepository } from '@api/repositories/oauth-state.repository.js';
import { encryptionService } from '@api/security/encryption.service.js';
import { sha256 } from '@api/security/hashing.service.js';
import { generateSecureToken } from '@api/security/random.service.js';
import { safeRedirectPath } from '@api/security/safe-redirect.js';
import type { CallbackStatus } from '@api/security/safe-redirect.js';
import { createGoogleOAuthClient } from './google-oauth.client.js';
import { verifyGoogleIdentity } from './google-identity.service.js';
import { GMAIL_MODIFY_SCOPE, GOOGLE_GMAIL_SCOPES } from './google-scopes.js';
import { googleTokenService } from './google-token.service.js';

function parseScopes(scope: string | null | undefined): string[] {
  return [...new Set((scope ?? '').split(/\s+/).filter(Boolean))].sort();
}

export class GoogleGmailService {
  async beginConnection(request: Request, redirectPath: unknown): Promise<string> {
    const auth = request.auth!;
    const existing = await connectedGoogleAccountRepository.findForUser(auth.user.id);
    const purpose =
      existing?.connection_status === 'REAUTH_REQUIRED' ? 'REAUTHORIZE_GMAIL' : 'CONNECT_GMAIL';
    const rawState = generateSecureToken();
    await oauthStateRepository.create({
      state_hash: sha256(rawState),
      purpose,
      initiating_user_id: auth.user.id,
      initiating_session_id: auth.id,
      expires_at: new Date(Date.now() + env.OAUTH_STATE_TTL_MINUTES * 60 * 1000),
      redirect_path: safeRedirectPath(redirectPath, '/settings/connections'),
    });
    await auditService.record({
      action: 'GMAIL_CONNECTION_STARTED',
      userId: auth.user.id,
      sessionId: auth.id,
      requestId: request.requestId,
      metadata: { purpose },
    });
    const needsConsent = !existing?.refresh_token_ciphertext || purpose === 'REAUTHORIZE_GMAIL';
    return createGoogleOAuthClient('GMAIL').generateAuthUrl({
      scope: [...GOOGLE_GMAIL_SCOPES],
      state: rawState,
      access_type: 'offline',
      include_granted_scopes: true,
      ...(needsConsent ? { prompt: 'consent' } : {}),
    });
  }

  async completeConnection(request: Request, code: unknown, state: unknown) {
    if (typeof code !== 'string' || typeof state !== 'string' || !code || !state) {
      throw new AppError('GMAIL_CONNECTION_FAILED', 'Gmail could not be connected.', 400);
    }
    try {
      const oauthState = await oauthStateRepository.consume(sha256(state), [
        'CONNECT_GMAIL',
        'REAUTHORIZE_GMAIL',
      ]);
      if (!oauthState.initiating_user_id) {
        throw new AppError(
          'AUTH_OAUTH_STATE_INVALID',
          'The authorization request is invalid.',
          400,
        );
      }
      if (
        !request.auth ||
        oauthState.initiating_user_id !== request.auth.user.id ||
        oauthState.initiating_session_id !== request.auth.id
      ) {
        throw new AppError(
          'AUTH_OAUTH_STATE_INVALID',
          'The authorization request is invalid.',
          400,
        );
      }
      const client = createGoogleOAuthClient('GMAIL');
      const { tokens } = await client.getToken(code);
      const identity = await verifyGoogleIdentity(client, tokens.id_token);
      const scopes = parseScopes(tokens.scope);
      const hasRequiredScope = scopes.includes(GMAIL_MODIFY_SCOPE);
      const existing = await connectedGoogleAccountRepository.findByUserAndSubject(
        oauthState.initiating_user_id,
        identity.subject,
      );
      const activeAccount = await connectedGoogleAccountRepository.findForUser(
        oauthState.initiating_user_id,
      );
      if (activeAccount && activeAccount.google_subject !== identity.subject) {
        await googleTokenService.revokeGoogleCredentials(activeAccount);
        // Persist a safe recovery state before replacing the identity. If the new
        // write fails, the revoked credentials are never presented as connected.
        await connectedGoogleAccountRepository.update(activeAccount.id, {
          access_token_ciphertext: null,
          access_token_iv: null,
          access_token_auth_tag: null,
          refresh_token_ciphertext: null,
          refresh_token_iv: null,
          refresh_token_auth_tag: null,
          encryption_key_version: null,
          access_token_expires_at: null,
          gmail_connected: false,
          connection_status: 'REVOKED',
          disconnected_at: new Date(),
          last_connection_error_code: 'IDENTITY_REPLACED',
          last_connection_error_at: new Date(),
        });
      }
      const encryptedAccess = tokens.access_token
        ? encryptionService.encrypt(tokens.access_token)
        : null;
      const encryptedRefresh = tokens.refresh_token
        ? encryptionService.encrypt(tokens.refresh_token)
        : existing?.refresh_token_ciphertext &&
            existing.refresh_token_iv &&
            existing.refresh_token_auth_tag
          ? {
              ciphertext: existing.refresh_token_ciphertext,
              iv: existing.refresh_token_iv,
              authTag: existing.refresh_token_auth_tag,
              keyVersion: existing.encryption_key_version!,
            }
          : null;
      const connected = hasRequiredScope && Boolean(encryptedRefresh);
      const status = connected ? 'CONNECTED' : 'REAUTH_REQUIRED';
      const now = new Date();
      await connectedGoogleAccountRepository.replaceActiveForUser(
        oauthState.initiating_user_id,
        identity.subject,
        {
          email: identity.email,
          granted_scopes: scopes,
          access_token_ciphertext: encryptedAccess?.ciphertext ?? null,
          access_token_iv: encryptedAccess?.iv ?? null,
          access_token_auth_tag: encryptedAccess?.authTag ?? null,
          refresh_token_ciphertext: encryptedRefresh?.ciphertext ?? null,
          refresh_token_iv: encryptedRefresh?.iv ?? null,
          refresh_token_auth_tag: encryptedRefresh?.authTag ?? null,
          encryption_key_version:
            encryptedAccess?.keyVersion ?? encryptedRefresh?.keyVersion ?? null,
          access_token_expires_at: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
          gmail_connected: connected,
          connection_status: status,
          connected_at: connected ? now : (existing?.connected_at ?? null),
          disconnected_at: null,
          last_connection_error_code: connected
            ? null
            : hasRequiredScope
              ? 'MISSING_REFRESH_TOKEN'
              : 'GMAIL_PERMISSION_INCOMPLETE',
          last_connection_error_at: connected ? null : now,
        },
      );
      await auditService.record({
        action: connected ? 'GMAIL_CONNECTION_SUCCEEDED' : 'GMAIL_CONNECTION_REAUTH_REQUIRED',
        result: connected ? 'SUCCESS' : 'FAILURE',
        userId: oauthState.initiating_user_id,
        ...(oauthState.initiating_session_id
          ? { sessionId: oauthState.initiating_session_id }
          : {}),
        requestId: request.requestId,
        metadata: { connectionStatus: status, scopeCount: scopes.length },
      });
      const callbackStatus: CallbackStatus = connected
        ? 'gmail_connected'
        : hasRequiredScope
          ? 'gmail_reauth_required'
          : 'gmail_permission_incomplete';
      return {
        status: callbackStatus,
        redirectPath: oauthState.redirect_path ?? '/settings/connections',
      };
    } catch (error) {
      await auditService.record({
        action: 'GMAIL_CONNECTION_FAILED',
        result: 'FAILURE',
        requestId: request.requestId,
        metadata: { code: error instanceof AppError ? error.code : 'GMAIL_CONNECTION_FAILED' },
      });
      if (error instanceof AppError) throw error;
      throw new AppError('GMAIL_CONNECTION_FAILED', 'Gmail could not be connected.', 400);
    }
  }

  async denyConnection(request: Request, state: unknown): Promise<string> {
    let userId: string | undefined;
    let sessionId: string | undefined;
    let redirectPath = '/settings/connections';
    if (typeof state === 'string' && state) {
      try {
        const oauthState = await oauthStateRepository.consume(sha256(state), [
          'CONNECT_GMAIL',
          'REAUTHORIZE_GMAIL',
        ]);
        userId = oauthState.initiating_user_id ?? undefined;
        sessionId = oauthState.initiating_session_id ?? undefined;
        redirectPath = oauthState.redirect_path ?? redirectPath;
      } catch {
        // Invalid state is intentionally indistinguishable at the browser redirect.
      }
    }
    await auditService.record({
      action: 'GMAIL_CONNECTION_DENIED',
      result: 'DENIED',
      requestId: request.requestId,
      ...(userId ? { userId } : {}),
      ...(sessionId ? { sessionId } : {}),
      metadata: { code: 'GMAIL_PERMISSION_DENIED' },
    });
    return redirectPath;
  }

  async status(userId: string) {
    const account = await connectedGoogleAccountRepository.findForUser(userId);
    if (!account) {
      return {
        connected: false,
        email: null,
        status: 'DISCONNECTED',
        grantedScopes: [],
        requiresReauthentication: false,
      };
    }
    return {
      connected: account.gmail_connected && account.connection_status === 'CONNECTED',
      email: account.email,
      status: account.connection_status,
      grantedScopes: account.granted_scopes,
      requiresReauthentication: account.connection_status === 'REAUTH_REQUIRED',
      connectedAt: account.connected_at?.toISOString() ?? null,
      updatedAt: account.updated_at.toISOString(),
    };
  }

  async disconnect(request: Request): Promise<void> {
    const auth = request.auth!;
    const account = await connectedGoogleAccountRepository.findForUser(auth.user.id);
    if (!account) return;
    await googleTokenService.revokeGoogleCredentials(account);
    await connectedGoogleAccountRepository.update(account.id, {
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
      disconnected_at: new Date(),
      last_connection_error_code: null,
      last_connection_error_at: null,
    });
    await auditService.record({
      action: 'GMAIL_CONNECTION_DISCONNECTED',
      result: 'SUCCESS',
      userId: auth.user.id,
      sessionId: auth.id,
      requestId: request.requestId,
    });
  }
}

export const googleGmailService = new GoogleGmailService();
