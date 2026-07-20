import type { Request } from 'express';

import { auditService } from '@api/audit/audit.service.js';
import { env } from '@api/config/env.js';
import { AppError } from '@api/errors/AppError.js';
import { connectedGoogleAccountRepository } from '@api/repositories/connected-google-account.repository.js';
import { oauthStateRepository } from '@api/repositories/oauth-state.repository.js';
import { sha256 } from '@api/security/hashing.service.js';
import { generateSecureToken } from '@api/security/random.service.js';
import { safeRedirectPath } from '@api/security/safe-redirect.js';
import { sessionService } from '@api/sessions/session.service.js';
import { createGoogleOAuthClient } from '@api/integrations/google/google-oauth.client.js';
import { verifyGoogleIdentity } from '@api/integrations/google/google-identity.service.js';
import { GOOGLE_LOGIN_SCOPES } from '@api/integrations/google/google-scopes.js';

function oauthExpiry(): Date {
  return new Date(Date.now() + env.OAUTH_STATE_TTL_MINUTES * 60 * 1000);
}

export class AuthService {
  async beginGoogleLogin(request: Request, redirectPath: unknown): Promise<string> {
    const rawState = generateSecureToken();
    await oauthStateRepository.create({
      state_hash: sha256(rawState),
      purpose: 'LOGIN',
      expires_at: oauthExpiry(),
      redirect_path: safeRedirectPath(redirectPath, '/dashboard'),
    });
    await auditService.record({
      action: 'AUTH_LOGIN_STARTED',
      requestId: request.requestId,
      metadata: { purpose: 'LOGIN' },
    });
    return createGoogleOAuthClient('LOGIN').generateAuthUrl({
      scope: [...GOOGLE_LOGIN_SCOPES],
      state: rawState,
    });
  }

  async completeGoogleLogin(request: Request, code: unknown, state: unknown) {
    if (typeof code !== 'string' || typeof state !== 'string' || !code || !state) {
      throw new AppError(
        'AUTH_GOOGLE_CALLBACK_FAILED',
        'Google sign-in could not be completed.',
        400,
      );
    }
    try {
      const oauthState = await oauthStateRepository.consume(sha256(state), ['LOGIN']);
      const client = createGoogleOAuthClient('LOGIN');
      const { tokens } = await client.getToken(code);
      const identity = await verifyGoogleIdentity(client, tokens.id_token);
      const created = await sessionService.createForGoogleIdentity(
        {
          googleSubject: identity.subject,
          email: identity.email,
          displayName: identity.displayName,
          avatarUrl: identity.avatarUrl,
          emailVerified: identity.emailVerified,
        },
        request,
      );
      await Promise.all([
        auditService.record({
          action: 'AUTH_LOGIN_SUCCEEDED',
          result: 'SUCCESS',
          userId: created.session.user.id,
          sessionId: created.session.id,
          requestId: request.requestId,
        }),
        auditService.record({
          action: 'SESSION_CREATED',
          result: 'SUCCESS',
          userId: created.session.user.id,
          sessionId: created.session.id,
          requestId: request.requestId,
        }),
      ]);
      return { ...created, redirectPath: oauthState.redirect_path ?? '/dashboard' };
    } catch (error) {
      await auditService.record({
        action: 'AUTH_LOGIN_FAILED',
        result: 'FAILURE',
        requestId: request.requestId,
        metadata: { code: error instanceof AppError ? error.code : 'AUTH_GOOGLE_CALLBACK_FAILED' },
      });
      if (error instanceof AppError) throw error;
      throw new AppError(
        'AUTH_GOOGLE_CALLBACK_FAILED',
        'Google sign-in could not be completed.',
        401,
      );
    }
  }

  async denyGoogleLogin(request: Request, state: unknown): Promise<void> {
    if (typeof state === 'string' && state) {
      try {
        await oauthStateRepository.consume(sha256(state), ['LOGIN']);
      } catch {
        // The browser still receives only the predefined failure redirect.
      }
    }
    await auditService.record({
      action: 'AUTH_LOGIN_FAILED',
      result: 'DENIED',
      requestId: request.requestId,
      metadata: { code: 'AUTH_GOOGLE_CALLBACK_FAILED' },
    });
  }

  async me(userId: string, authUser: NonNullable<Request['auth']>['user']) {
    const account = await connectedGoogleAccountRepository.findForUser(userId);
    return {
      user: {
        ...authUser,
        gmailConnected:
          account?.gmail_connected === true && account.connection_status === 'CONNECTED',
      },
    };
  }
}

export const authService = new AuthService();
