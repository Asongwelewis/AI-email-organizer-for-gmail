import { env } from '@api/config/env.js';
import { logger } from '@api/config/logger.js';

/**
 * Keeps a free Render instance from sleeping by requesting its own public /health.
 *
 * The free plan spins a service down after 15 minutes without inbound traffic, and asleep, the
 * watcher cannot sort the mail that arrives. Work the process does on its own does not count —
 * Render only sees inbound requests — but a request to API_BASE_URL leaves through Render's edge
 * and comes back in like any visitor's, and that does.
 *
 * It cannot wake an instance that is already asleep; nothing inside a stopped process can. That
 * is what `.github/workflows/wake-api.yml` is for, and why both exist. Staying up all month spends
 * about 744 of the workspace's 750 free instance hours, so this belongs to a workspace whose only
 * free web service is this one.
 */

let timer: NodeJS.Timeout | null = null;

export function keepAwakeUrl(): string {
  return new URL('/health', env.API_BASE_URL).toString();
}

export async function pingSelf(fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetcher(keepAwakeUrl(), {
      signal: AbortSignal.timeout(15_000),
      headers: { 'user-agent': 'mailmind-keep-awake' },
    });
    if (!response.ok) logger.warn({ status: response.status }, 'keep-awake ping was refused');
    return response.ok;
  } catch (error) {
    // A missed ping is fine as long as the next one lands inside the 15-minute window.
    logger.warn(
      { errorType: error instanceof Error ? error.name : 'UnknownError' },
      'keep-awake ping failed',
    );
    return false;
  }
}

export function startKeepAwake(
  intervalMinutes = env.KEEP_AWAKE_INTERVAL_MINUTES,
  fetcher: typeof fetch = fetch,
): void {
  // Production only: a developer's laptop has nothing to keep awake, and pinging the configured
  // API_BASE_URL from it would be pinging production.
  if (timer || intervalMinutes <= 0 || env.NODE_ENV !== 'production') return;
  timer = setInterval(() => void pingSelf(fetcher), intervalMinutes * 60_000);
  timer.unref();
  logger.info({ intervalMinutes }, 'keep-awake ping started');
}

export function stopKeepAwake(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
