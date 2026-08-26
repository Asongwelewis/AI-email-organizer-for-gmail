import { env } from '@api/config/env.js';

/**
 * The Gmail authority MailMind asks for, and the authority it settles for.
 *
 * `gmail.modify` is a Google **restricted** scope: it can alter and delete a person's mail, which
 * is what pulls an app into verification plus an annual CASA Tier 2 assessment. Once Gmail left
 * the write path the product stopped using it — the sync boundary is metadata-only, so
 * `gmail.readonly` covers everything MailMind actually does.
 *
 * `modify` is still defined, because the label export from card 21 genuinely needs it. Asking for
 * it is a deliberate choice made by configuration, not the default.
 */

export const GOOGLE_LOGIN_SCOPES = ['openid', 'email', 'profile'] as const;

/** Headers, ids, flags, snippets. Everything the metadata-only sync reads. */
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

/** Restricted. Only the label export needs it, and only when it is turned on. */
export const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

/** The Gmail scope this deployment asks a new connection for. */
export function requestedGmailScope(): string {
  return env.GMAIL_WRITE_ENABLED ? GMAIL_MODIFY_SCOPE : GMAIL_READONLY_SCOPE;
}

export function googleGmailScopes(): string[] {
  return [...GOOGLE_LOGIN_SCOPES, requestedGmailScope()];
}

/**
 * Can MailMind read this mailbox? `modify` implies read, so a grant made before the downgrade
 * still satisfies every read path and must not be treated as a broken connection.
 */
export function hasGmailReadScope(scopes: readonly string[]): boolean {
  return scopes.includes(GMAIL_READONLY_SCOPE) || scopes.includes(GMAIL_MODIFY_SCOPE);
}

/** Can MailMind write to this mailbox? Only the restricted scope grants that. */
export function hasGmailWriteScope(scopes: readonly string[]): boolean {
  return scopes.includes(GMAIL_MODIFY_SCOPE);
}

/**
 * A grant wider than this deployment uses.
 *
 * Google's grants are cumulative per client, so asking for less does not take the wider scope
 * back — an account connected before the downgrade keeps `modify` until it is revoked and granted
 * again. That is worth telling someone about rather than quietly holding on to.
 */
export function holdsUnusedWriteScope(scopes: readonly string[]): boolean {
  return !env.GMAIL_WRITE_ENABLED && hasGmailWriteScope(scopes);
}
