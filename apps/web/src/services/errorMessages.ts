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
  RATE_LIMIT_EXCEEDED: 'Too many attempts. Please try again shortly.',
  INTERNAL_SERVER_ERROR: 'Something went wrong on our side. Please try again.',
};

export function getApiErrorCode(error: unknown): string | null {
  if (!axios.isAxiosError<ApiErrorPayload>(error)) return null;
  return error.response?.data?.error?.code ?? null;
}

export function getSafeErrorMessage(
  error: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  const code = getApiErrorCode(error);
  return code ? (SAFE_ERROR_MESSAGES[code] ?? fallback) : fallback;
}
