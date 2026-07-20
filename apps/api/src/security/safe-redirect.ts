const ALLOWED_PATHS = new Set(['/dashboard', '/settings/connections', '/login']);

export function safeRedirectPath(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !ALLOWED_PATHS.has(value)) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('://')) return fallback;
  return value;
}

export function frontendUrl(origin: string, path: string, status?: string): string {
  const url = new URL(path, origin);
  if (status) url.searchParams.set('status', status);
  return url.toString();
}
