import type { CookieOptions, Response } from 'express';

import { env } from '@api/config/env.js';

export const SESSION_COOKIE_NAME = 'mailmind_session';

export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAME_SITE,
    path: '/',
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
    maxAge: env.REFRESH_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  };
}

export function setSessionCookie(response: Response, rawToken: string): void {
  response.cookie(SESSION_COOKIE_NAME, rawToken, sessionCookieOptions());
}

export function clearSessionCookie(response: Response): void {
  const { maxAge: _maxAge, ...options } = sessionCookieOptions();
  response.clearCookie(SESSION_COOKIE_NAME, options);
}
