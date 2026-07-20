import type { Request, Response } from 'express';

import { auditService } from '@api/audit/audit.service.js';
import { env } from '@api/config/env.js';
import { authService } from './auth.service.js';
import { clearSessionCookie, setSessionCookie } from '@api/sessions/session.cookies.js';
import { sessionService } from '@api/sessions/session.service.js';
import { frontendUrl } from '@api/security/safe-redirect.js';

export class AuthController {
  async startGoogle(request: Request, response: Response): Promise<void> {
    response.redirect(await authService.beginGoogleLogin(request, request.query['redirect']));
  }

  async googleCallback(request: Request, response: Response): Promise<void> {
    if (typeof request.query['error'] === 'string') {
      const redirectPath = await authService.denyGoogleLogin(request, request.query['state']);
      response.redirect(frontendUrl(env.WEB_APP_URL, redirectPath, 'login_failed'));
      return;
    }
    try {
      const result = await authService.completeGoogleLogin(
        request,
        request.query['code'],
        request.query['state'],
      );
      setSessionCookie(response, result.rawToken);
      response.redirect(frontendUrl(env.WEB_APP_URL, result.redirectPath, 'login_succeeded'));
    } catch {
      response.redirect(frontendUrl(env.WEB_APP_URL, '/login', 'login_failed'));
    }
  }

  async me(request: Request, response: Response): Promise<void> {
    const auth = request.auth!;
    response.json(await authService.me(auth.user.id, auth.user));
  }

  async refresh(request: Request, response: Response): Promise<void> {
    const result = await sessionService.rotate(request);
    setSessionCookie(response, result.rawToken);
    await auditService.record({
      action: 'SESSION_REFRESHED',
      result: 'SUCCESS',
      userId: result.session.user.id,
      sessionId: result.session.id,
      requestId: request.requestId,
    });
    response.json({ user: result.session.user });
  }

  async logout(request: Request, response: Response): Promise<void> {
    const session = await sessionService.revokeCurrent(request);
    clearSessionCookie(response);
    if (session) {
      await auditService.record({
        action: 'SESSION_REVOKED',
        result: 'SUCCESS',
        userId: session.user.id,
        sessionId: session.id,
        requestId: request.requestId,
      });
    }
    response.json({ success: true });
  }

  async logoutAll(request: Request, response: Response): Promise<void> {
    const auth = request.auth!;
    const result = await sessionService.revokeAll(auth.user.id);
    clearSessionCookie(response);
    await auditService.record({
      action: 'ALL_SESSIONS_REVOKED',
      result: 'SUCCESS',
      userId: auth.user.id,
      sessionId: auth.id,
      requestId: request.requestId,
      metadata: { count: result.count },
    });
    response.json({ success: true, revokedSessions: result.count });
  }
}

export const authController = new AuthController();
