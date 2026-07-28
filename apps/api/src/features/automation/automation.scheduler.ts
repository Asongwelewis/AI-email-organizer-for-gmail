import { env } from '@api/config/env.js';
import { logger, safeErrorDetails } from '@api/config/logger.js';
import { captureApiException } from '@api/observability/sentry.js';
import { automationService } from './automation.service.js';

let timer: NodeJS.Timeout | null = null;
let ticking = false;

async function tick(): Promise<void> {
  if (ticking || !env.AUTOMATION_ENABLED || !env.OPENAI_API_KEY) return;
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
}

export function stopAutomationScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
