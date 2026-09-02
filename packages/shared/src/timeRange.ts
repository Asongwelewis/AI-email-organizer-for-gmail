/** Time windows used by the recent-mail views. */
export const EMAIL_TIME_RANGES = ['24h', '7d', '30d', 'all'] as const;

export type EmailTimeRange = (typeof EMAIL_TIME_RANGES)[number];

export const DEFAULT_EMAIL_TIME_RANGE: EmailTimeRange = '24h';

export const EMAIL_TIME_RANGE_LABELS: Record<EmailTimeRange, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  all: 'All mail',
};

export function isEmailTimeRange(value: unknown): value is EmailTimeRange {
  return typeof value === 'string' && (EMAIL_TIME_RANGES as readonly string[]).includes(value);
}

/** Returns the inclusive lower bound for a window, or null for all mail. */
export function emailTimeRangeSince(
  range: EmailTimeRange = DEFAULT_EMAIL_TIME_RANGE,
  now = new Date(),
): Date | null {
  if (range === 'all') return null;
  const days = range === '24h' ? 1 / 24 : range === '7d' ? 7 : 30;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
