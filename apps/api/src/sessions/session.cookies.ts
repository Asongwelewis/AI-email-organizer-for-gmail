import type { CookieOptions, Response } from 'express';

import { env } from '@api/config/env.js';

export const SESSION_COOKIE_NAME = 'mailmind_session';

/**
 * `expiresAt` makes the cookie expire with the session row. Without it the cookie gets the full
 * idle window, which is what a brand-new session has.
 */
export function sessionCookieOptions(expiresAt?: Date): CookieOptions {
  const isProduction = env.NODE_ENV === 'production';

  return {
    httpOnly: true,
    secure: isProduction ? true : env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAME_SITE,
    path: '/',
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
    maxAge: expiresAt
      ? Math.max(0, expiresAt.getTime() - Date.now())
      : env.REFRESH_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  };
}

export function setSessionCookie(response: Response, rawToken: string, expiresAt?: Date): void {
  response.cookie(SESSION_COOKIE_NAME, rawToken, sessionCookieOptions(expiresAt));
}

export function clearSessionCookie(response: Response): void {
  const { maxAge: _maxAge, ...options } = sessionCookieOptions();
  response.clearCookie(SESSION_COOKIE_NAME, options);
}
