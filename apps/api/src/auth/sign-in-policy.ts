import { env } from '@api/config/env.js';

/**
 * Who may use this deployment at all.
 *
 * Empty `SIGN_IN_ALLOWED_EMAILS` keeps it open to anyone with a Google account, and the beta cap
 * then decides who may connect Gmail. Set, it is a private server: the Google callback turns
 * everyone else away before an account row exists, and a session that predates the list stops
 * working on its next request, so removing someone from the list removes them at once.
 */
export function isSignInAllowed(email: string): boolean {
  const allowed = env.SIGN_IN_ALLOWED_EMAILS;
  return allowed.length === 0 || allowed.includes(email.trim().toLowerCase());
}

export const SIGN_IN_RESTRICTED_MESSAGE = 'This AMO server is private.';
