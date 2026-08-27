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
import { userRepository } from '@api/repositories/user.repository.js';
import { prisma } from '@api/database/prisma.js';
import { googleTokenService } from '@api/integrations/google/google-token.service.js';

function oauthExpiry(): Date {
  return new Date(Date.now() + env.OAUTH_STATE_TTL_MINUTES * 60 * 1000);
}

export class AuthService {
  /**
   * Deletes an account and everything MailMind stored about it.
   *
   * Required by Google's restricted-scope policy, and it has to be real: the mail metadata, the
   * facets, the folders, the runs and the decisions all hang off `connected_google_accounts`,
   * which hangs off `users`, so one delete takes the lot through the cascades already declared in
   * the schema.
   *
   * Two things are deliberately not cascaded. Google's tokens live on Google, so they are revoked
   * first — deleting our copy would leave a live grant nobody can see. And `audit_logs` is
   * detached rather than deleted: the record that an account existed and was deleted is the
   * evidence that the deletion happened, and destroying it destroys the proof. What is left
   * carries no user id, no session id, and no email.
   *
   * Revocation is best-effort by design. If Google is unreachable the deletion still proceeds:
   * refusing would mean a person who asked to be forgotten stays in the database because a third
   * party had an outage.
   */
  async deleteAccount(userId: string): Promise<{ connectedAccounts: number }> {
    const accounts = await prisma.connected_google_accounts.findMany({
      where: { user_id: userId },
    });
    for (const account of accounts) {
      await googleTokenService.revokeGoogleCredentials(account);
    }

    await prisma.$transaction([
      /*
       * `audit_logs.user_id` and `audit_logs.session_id` are nullable and carry no cascade, so
       * they would block the delete. Nulling them is also the right outcome: the trail survives
       * and stops pointing at a person who is no longer here.
       */
      prisma.audit_logs.updateMany({
        where: { user_id: userId },
        data: { user_id: null, session_id: null },
      }),
      prisma.users.delete({ where: { id: userId } }),
    ]);

    /*
     * Recorded without a user id, because there is no longer a user to attribute it to and
     * writing one would re-introduce the identifier the deletion just removed.
     */
    await auditService.record({
      action: 'ACCOUNT_DELETED',
      result: 'SUCCESS',
      metadata: { connectedAccounts: accounts.length },
    });
    return { connectedAccounts: accounts.length };
  }

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

  async denyGoogleLogin(request: Request, state: unknown): Promise<string> {
    let redirectPath = '/login';
    if (typeof state === 'string' && state) {
      try {
        const oauthState = await oauthStateRepository.consume(sha256(state), ['LOGIN']);
        redirectPath = oauthState.redirect_path ?? redirectPath;
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
    return redirectPath;
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

  async completeTutorial(userId: string) {
    const completedAt = await userRepository.completeTutorial(userId);
    return { success: true, tutorialCompletedAt: completedAt.toISOString() };
  }
}

export const authService = new AuthService();
