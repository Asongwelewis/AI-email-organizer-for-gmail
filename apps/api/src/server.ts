import { app } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { migrateIfPending } from './database/migrations.js';
import { prisma, startDatabaseHeartbeat, stopDatabaseHeartbeat } from './database/prisma.js';
import { captureApiException, closeSentry } from './observability/sentry.js';
import {
  startAutomationScheduler,
  stopAutomationScheduler,
} from './features/automation/automation.scheduler.js';

try {
  await prisma.$connect();
  logger.info('Database connection established');
} catch (error) {
  captureApiException(error, { phase: 'database_connect' });
  logger.fatal(
    { errorType: error instanceof Error ? error.name : 'UnknownError' },
    'Unable to connect to the database',
  );
  await closeSentry();
  process.exit(1);
}

if (env.MIGRATE_ON_START) {
  try {
    await migrateIfPending();
  } catch (error) {
    // Serving traffic against a schema the code does not match is worse than not serving it.
    captureApiException(error, { phase: 'database_migrate' });
    logger.fatal(
      { errorType: error instanceof Error ? error.name : 'UnknownError' },
      'Unable to apply database migrations',
    );
    await prisma.$disconnect().catch(() => undefined);
    await closeSentry();
    process.exit(1);
  }
}

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'MailMind AI API is ready');
  startAutomationScheduler();
  startDatabaseHeartbeat();
});

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  stopAutomationScheduler();
  stopDatabaseHeartbeat();
  logger.info({ signal }, 'Shutting down API server');
  const forcedExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out');
    server.closeAllConnections();
    void prisma
      .$disconnect()
      .catch(() => undefined)
      .finally(async () => {
        await closeSentry();
        process.exit(1);
      });
  }, 10_000);
  forcedExit.unref();
  server.close(async () => {
    clearTimeout(forcedExit);
    try {
      await prisma.$disconnect();
      await closeSentry();
      process.exit(0);
    } catch {
      logger.error('Unable to close the database connection cleanly');
      await closeSentry();
      process.exit(1);
    }
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
