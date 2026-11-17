import { env } from '@api/config/env.js';
import { logger, safeErrorDetails } from '@api/config/logger.js';
import { migrateIfPending } from '@api/database/migrations.js';
import { prisma } from '@api/database/prisma.js';
import { runAutomationPass } from '@api/features/automation/automation.scheduler.js';
import { captureApiException, closeSentry } from '@api/observability/sentry.js';
import { runHousekeeping } from '@api/services/housekeeping.js';

/**
 * One automation pass, then exit: what a Railway cron service runs every five minutes.
 *
 * It does what the web service's timers would otherwise do — check every mailbox for new mail and
 * sort it, start any first setup that is waiting, run the full runs that are due — so the web
 * service has nothing to do between visits and can sleep. Housekeeping rides along every six
 * hours, on the pass that starts in the first five minutes of the hour.
 *
 * Exit code 1 means the pass failed; the next one starts on schedule regardless, and every
 * long-running step holds a lease, so a pass that overlaps a slow one waits rather than doubles.
 */
const HOUSEKEEPING_EVERY_HOURS = 6;

let exitCode = 0;
const started = Date.now();
try {
  await prisma.$connect();
  if (env.MIGRATE_ON_START) await migrateIfPending();
  await runAutomationPass();
  const now = new Date();
  if (now.getUTCHours() % HOUSEKEEPING_EVERY_HOURS === 0 && now.getUTCMinutes() < 5) {
    await runHousekeeping(now);
  }
  logger.info({ durationMs: Date.now() - started }, 'automation job finished');
} catch (error) {
  exitCode = 1;
  captureApiException(error, { operation: 'automation_job' });
  logger.error(safeErrorDetails(error), 'automation job failed');
} finally {
  await prisma.$disconnect().catch(() => undefined);
  await closeSentry();
}
process.exit(exitCode);
