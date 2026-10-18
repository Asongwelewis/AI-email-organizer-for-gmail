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

const HOUR_MS = 60 * 60 * 1000;

/** How far back each window reaches. Hours, so a window's name and its length cannot disagree. */
const WINDOW_HOURS: Record<Exclude<EmailTimeRange, 'all'>, number> = {
  '24h': 24,
  '7d': 7 * 24,
  '30d': 30 * 24,
};

/**
 * Returns the inclusive lower bound for a window, or null for all mail.
 *
 * "Last 24 hours" used to reach back one hour: it was written as 1/24 of a day and then multiplied
 * by a day's milliseconds, so a day became an hour. Everything that arrived earlier that day was
 * missing from the default view.
 */
export function emailTimeRangeSince(
  range: EmailTimeRange = DEFAULT_EMAIL_TIME_RANGE,
  now = new Date(),
): Date | null {
  if (range === 'all') return null;
  return new Date(now.getTime() - WINDOW_HOURS[range] * HOUR_MS);
}
