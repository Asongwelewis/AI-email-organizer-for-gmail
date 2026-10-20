import { env } from '@api/config/env.js';
import { logger, safeErrorDetails } from '@api/config/logger.js';
import { captureApiException } from '@api/observability/sentry.js';
// One engine. `runScheduledAccount` refreshes the mailbox, classifies into facets, then files
// through the canonical pivot — it no longer reaches the retired taxonomy classifier.
import { automationService } from './automation.service.js';
import { onboardingService } from '@api/features/onboarding/onboarding.service.js';
import { forEachWithConcurrency } from '@api/utils/concurrency.js';
import { mailWatchService } from './mail-watch.service.js';

/*
 * Two clocks.
 *
 * The full-run tick looks every AUTOMATION_POLL_INTERVAL_MINUTES for an account whose run is due
 * at one of AUTOMATION_FULL_RUN_HOURS_UTC, and does the whole job: backlog, re-classification,
 * filing. The watch tick asks every AUTOMATION_CHECK_INTERVAL_SECONDS whether anything new has
 * arrived and sorts only that, so mail lands in its folder within a minute or two instead of at
 * the next full run.
 *
 * Neither keeps the process awake. On the free plan only inbound requests do that; see
 * `services/keepAwake.ts` and `.github/workflows/wake-api.yml`.
 */

let timer: NodeJS.Timeout | null = null;
let watchTimer: NodeJS.Timeout | null = null;
let ticking = false;
let watching = false;

async function tick(): Promise<void> {
  if (ticking || !env.AUTOMATION_ENABLED || !env.GEMINI_API_KEY) return;
  ticking = true;
  try {
    const accounts = await automationService.eligibleScheduledAccounts();
    // A few at a time: each full run holds the shared Gemini queue for minutes, and one slow
    // mailbox used to hold up every mailbox behind it in a strictly sequential loop.
    await forEachWithConcurrency(accounts, env.AUTOMATION_FULL_RUN_CONCURRENCY, async (account) => {
      try {
        await automationService.runScheduledAccount(account.id, account.user_id);
      } catch (error) {
        captureApiException(error, { operation: 'scheduled_automation_account' });
        logger.error(
          { ...safeErrorDetails(error), accountId: account.id },
          'scheduled automation account failed',
        );
      }
    });
  } catch (error) {
    captureApiException(error, { operation: 'scheduled_automation_tick' });
    logger.error(safeErrorDetails(error), 'scheduled automation tick failed');
  } finally {
    ticking = false;
  }
}

/**
 * One pass of the watcher over every watched mailbox, AUTOMATION_WATCH_CONCURRENCY at a time. A
 * check is almost always one Gmail call answering "nothing new", so several hundred mailboxes fit
 * inside the minute in parallel where one after another they would not. A pass still sorting when
 * the next is due is not overlapped: the next simply waits its turn.
 *
 * The onboarding sweep rides on the same clock: a mailbox whose first setup stopped — a restart,
 * the shared budget, a key not set yet — is started again here, with nobody pressing anything.
 */
async function watchTick(): Promise<void> {
  if (watching || !env.AUTOMATION_ENABLED) return;
  watching = true;
  try {
    try {
      await onboardingService.sweep();
    } catch (error) {
      captureApiException(error, { operation: 'onboarding_sweep' });
      logger.error(safeErrorDetails(error), 'onboarding sweep failed');
    }
    const accounts = await mailWatchService.eligibleAccounts();
    await forEachWithConcurrency(accounts, env.AUTOMATION_WATCH_CONCURRENCY, async (account) => {
      try {
        const result = await mailWatchService.check(account.id, account.user_id);
        if (result.outcome === 'CHECKED' && (result.sorted ?? 0) > 0) {
          logger.info({ accountId: account.id, ...result }, 'new mail sorted');
        }
      } catch (error) {
        captureApiException(error, { operation: 'mail_watch_account' });
        logger.error(
          { ...safeErrorDetails(error), accountId: account.id },
          'mail watch check failed',
        );
      }
    });
  } catch (error) {
    captureApiException(error, { operation: 'mail_watch_tick' });
    logger.error(safeErrorDetails(error), 'mail watch tick failed');
  } finally {
    watching = false;
  }
}

export function startAutomationScheduler(): void {
  if (timer || !env.AUTOMATION_ENABLED) return;
  timer = setInterval(() => void tick(), env.AUTOMATION_POLL_INTERVAL_MINUTES * 60_000);
  timer.unref();
  setImmediate(() => void tick());
  if (env.AUTOMATION_CHECK_INTERVAL_SECONDS > 0) {
    watchTimer = setInterval(() => void watchTick(), env.AUTOMATION_CHECK_INTERVAL_SECONDS * 1000);
    watchTimer.unref();
  }
  logger.info(
    {
      intervalMinutes: env.AUTOMATION_POLL_INTERVAL_MINUTES,
      fullRunHoursUtc: env.AUTOMATION_FULL_RUN_HOURS_UTC,
      checkIntervalSeconds: env.AUTOMATION_CHECK_INTERVAL_SECONDS,
    },
    'automation scheduler started',
  );
  // Every tick returns early without a key, so the timer runs and nothing happens. From 29 Aug to
  // 27 Sep 2026 that was the whole story of production: a month of due runs skipped with nothing
  // in the logs to say so. Said once per boot rather than per tick, because the tick is every 15
  // minutes and the fix is an operator setting, not something a retry will change.
  if (!env.GEMINI_API_KEY) {
    logger.warn(
      'automation scheduler is idle: GEMINI_API_KEY is not set, so no scheduled run will start',
    );
  }
  if (env.AUTOMATION_SCHEDULE_HOUR_UTC !== undefined) {
    logger.warn(
      { fullRunHoursUtc: env.AUTOMATION_FULL_RUN_HOURS_UTC },
      'AUTOMATION_SCHEDULE_HOUR_UTC is ignored; set AUTOMATION_FULL_RUN_HOURS_UTC instead',
    );
  }
}

export function stopAutomationScheduler(): void {
  if (timer) clearInterval(timer);
  if (watchTimer) clearInterval(watchTimer);
  timer = null;
  watchTimer = null;
}
