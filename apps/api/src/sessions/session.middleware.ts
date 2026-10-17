import type { NextFunction, Request, Response } from 'express';

import { setSessionCookie } from './session.cookies.js';
import { sessionService } from './session.service.js';

/**
 * Every authenticated route goes through here, so every one of them keeps an active session
 * alive. When the row was extended the cookie is re-issued in the same response — same token,
 * new lifetime — because a browser copy that expired before the row would log the person out
 * anyway.
 */
export async function requireSession(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { session, renewedToken } = await sessionService.authenticateAndRenew(request);
    request.auth = session;
    if (renewedToken) setSessionCookie(response, renewedToken, new Date(session.expiresAt));
    next();
  } catch (error) {
    next(error);
  }
}
