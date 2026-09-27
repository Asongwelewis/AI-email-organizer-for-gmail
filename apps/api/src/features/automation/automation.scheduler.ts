import { env } from '@api/config/env.js';
import { logger, safeErrorDetails } from '@api/config/logger.js';
import { captureApiException } from '@api/observability/sentry.js';
// One engine. `runScheduledAccount` refreshes the mailbox, classifies into facets, then files
// through the canonical pivot — it no longer reaches the retired taxonomy classifier.
import { automationService } from './automation.service.js';

let timer: NodeJS.Timeout | null = null;
let ticking = false;

async function tick(): Promise<void> {
  if (ticking || !env.AUTOMATION_ENABLED || !env.GEMINI_API_KEY) return;
  ticking = true;
  try {
    const accounts = await automationService.eligibleScheduledAccounts();
    for (const account of accounts) {
      try {
        await automationService.runScheduledAccount(account.id, account.user_id);
      } catch (error) {
        captureApiException(error, { operation: 'scheduled_automation_account' });
        logger.error(
          { ...safeErrorDetails(error), accountId: account.id },
          'scheduled automation account failed',
        );
      }
    }
  } catch (error) {
    captureApiException(error, { operation: 'scheduled_automation_tick' });
    logger.error(safeErrorDetails(error), 'scheduled automation tick failed');
  } finally {
    ticking = false;
  }
}

export function startAutomationScheduler(): void {
  if (timer || !env.AUTOMATION_ENABLED) return;
  timer = setInterval(() => void tick(), env.AUTOMATION_POLL_INTERVAL_MINUTES * 60_000);
  timer.unref();
  setImmediate(() => void tick());
  logger.info(
    { intervalMinutes: env.AUTOMATION_POLL_INTERVAL_MINUTES },
    'daily automation scheduler started',
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
}

export function stopAutomationScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
