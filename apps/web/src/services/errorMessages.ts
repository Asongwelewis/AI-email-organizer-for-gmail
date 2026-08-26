import axios from 'axios';

import type { ApiErrorPayload } from '@web/types/auth';

const SAFE_ERROR_MESSAGES: Record<string, string> = {
  AUTHENTICATION_REQUIRED: 'Please sign in to continue.',
  AUTH_SESSION_EXPIRED: 'Your session expired. Please sign in again.',
  AUTH_SESSION_REVOKED: 'This session is no longer active. Please sign in again.',
  AUTH_USER_SUSPENDED: 'This account is currently suspended.',
  AUTH_USER_DELETED: 'This account is no longer available.',
  GMAIL_PERMISSION_DENIED: 'Gmail access was not approved. Your MailMind login is still active.',
  GMAIL_PERMISSION_INCOMPLETE:
    'MailMind did not receive all required Gmail permissions. Please reconnect and approve the requested access.',
  GMAIL_REAUTH_REQUIRED: 'Your Gmail connection needs to be renewed.',
  GMAIL_CONNECTION_FAILED: 'We could not update your Gmail connection. Please try again.',
  GMAIL_ACCOUNT_NOT_CONNECTED: 'Connect Gmail before working with labels.',
  GMAIL_WRITE_SCOPE_MISSING:
    'This mailbox was connected for reading only, so MailMind cannot write labels into it. Your folders are unaffected — they are built here, not in Gmail.',
  GMAIL_WRITE_DISABLED:
    'This MailMind is not set up to write labels into Gmail. Your folders are here either way — nothing in the app depends on them existing in Gmail.',
  LABEL_NAME_INVALID:
    'That label name cannot be used. Use 2-60 characters, no slashes, and something more specific than a generic word.',
  LABEL_DUPLICATE: 'Two of those labels are too similar to keep both. Rename one and try again.',
  LABEL_LIMIT_REACHED: 'This account has reached its label limit.',
  LABEL_SET_EMPTY: 'Select at least one label before confirming.',
  LABEL_NOT_FOUND: 'That label was not found for this account.',
  LABEL_VALIDATION_FAILED: 'That label request was not valid.',
  LABEL_PROPOSAL_NOT_ENOUGH_MAIL: 'Synchronize more mail before proposing a folder tree.',
  LABEL_PLAN_EMPTY: 'The planner found no folders worth creating for this mailbox yet.',
  LABEL_PLAN_NOT_FOUND: 'That proposed folder tree was not found.',
  LABEL_PLAN_NOT_PENDING: 'That proposed folder tree was already reviewed. Propose a new one.',
  LABEL_PLAN_NODE_NOT_FOUND: 'One of the selected folders is not part of that proposal.',
  LABEL_PROPOSAL_ALREADY_RUNNING:
    'Another label or automation run is already active for this Gmail account.',
  ACTIVITY_RUN_NOT_FOUND: 'That run was not found for this account.',
  ACTIVITY_RUN_CONFLICT: 'That operation is already running.',
  ACTIVITY_VALIDATION_FAILED: 'That activity request was not valid.',
  RUN_ABANDONED:
    'The server restarted while this run was in progress. No work was lost; run it again to continue.',
  CSRF_ORIGIN_INVALID: 'This request came from an origin MailMind does not trust.',
  RATE_LIMIT_EXCEEDED: 'Too many attempts. Please try again shortly.',
  INTERNAL_SERVER_ERROR: 'Something went wrong on our side. Please try again.',
};

export function getApiErrorCode(error: unknown): string | null {
  if (!axios.isAxiosError<ApiErrorPayload>(error)) return null;
  return error.response?.data?.error?.code ?? null;
}

export function getApiErrorDetail(error: unknown): string | null {
  if (!axios.isAxiosError<ApiErrorPayload>(error)) return null;
  return error.response?.data?.error?.message ?? null;
}

/**
 * Prefers a curated message, then the server's own code and message, and only then the
 * caller's fallback. A response the client does not recognize must still be legible:
 * silently generic errors are how a broken flow stays invisible.
 */
export function getSafeErrorMessage(
  error: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  const code = getApiErrorCode(error);
  if (code && SAFE_ERROR_MESSAGES[code]) return SAFE_ERROR_MESSAGES[code];
  const detail = getApiErrorDetail(error);
  if (code && detail) return `${code}: ${detail}`;
  if (code) return code;
  if (detail) return detail;
  return fallback;
}
