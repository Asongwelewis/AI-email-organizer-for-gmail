const ALLOWED_PATHS = new Set(['/dashboard', '/settings/connections', '/login', '/auth/callback']);

export const CALLBACK_STATUSES = [
  'login_success',
  'login_failed',
  'gmail_connected',
  'gmail_denied',
  'gmail_permission_incomplete',
  'gmail_reauth_required',
  'gmail_connection_failed',
] as const;

export type CallbackStatus = (typeof CALLBACK_STATUSES)[number];

export function safeRedirectPath(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !ALLOWED_PATHS.has(value)) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('://')) return fallback;
  return value;
}

export function frontendUrl(origin: string, path: string, status?: CallbackStatus): string {
  const url = new URL(path, origin);
  if (status) url.searchParams.set('status', status);
  return url.toString();
}
