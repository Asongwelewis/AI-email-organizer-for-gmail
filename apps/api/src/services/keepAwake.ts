import { env } from '@api/config/env.js';
import { logger } from '@api/config/logger.js';

/**
 * Keeps a free Render instance from sleeping in the middle of a job, and at no other time.
 *
 * The free plan spins a service down after 15 minutes without inbound traffic and kills whatever
 * the process was doing. Work the process does on its own does not count — Render only sees
 * inbound requests — but a request to API_BASE_URL leaves through Render's edge and comes back in
 * like any visitor's, and that does.
 *
 * Until November 2026 this pinged around the clock. That spent 720–744 of the 750 free instance
 * hours a workspace shares each month, and on 25 October the workspace ran out: Render suspended
 * every free service in it, this API included, until the 1st. Now the instance sleeps between
 * wake-ups — a visitor, or `.github/workflows/wake-api.yml` every three hours — and pings itself
 * only while a full run or an activity run (a first setup, a sync) is still going, so a job that
 * outlasts the 15-minute window is not cut off halfway. When the work ends, so do the pings.
 */

let timer: NodeJS.Timeout | null = null;
let inFlight = 0;

export function keepAwakeUrl(): string {
  return new URL('/health', env.API_BASE_URL).toString();
}

/** Whether any job is holding the instance awake. */
export function workInFlight(): boolean {
  return inFlight > 0;
}

/** Runs `work`, and keeps the instance awake until it settles, however it settles. */
export async function holdAwake<T>(work: () => Promise<T>): Promise<T> {
  inFlight += 1;
  try {
    return await work();
  } finally {
    inFlight -= 1;
  }
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
  busy: () => boolean = workInFlight,
): void {
  // Deployments only: a developer's laptop has nothing to keep awake, and pinging the configured
  // API_BASE_URL from it would be pinging production. Not NODE_ENV alone — see `IS_DEPLOYED`.
  if (timer || intervalMinutes <= 0 || !env.IS_DEPLOYED) return;
  timer = setInterval(() => {
    if (busy()) void pingSelf(fetcher);
  }, intervalMinutes * 60_000);
  timer.unref();
  logger.info({ intervalMinutes }, 'keep-awake ping started; it pings only while work is running');
}

export function stopKeepAwake(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
