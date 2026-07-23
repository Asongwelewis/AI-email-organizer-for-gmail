import { app } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { prisma } from './database/prisma.js';

try {
  await prisma.$connect();
  logger.info('Database connection established');
} catch (error) {
  logger.fatal(
    { errorType: error instanceof Error ? error.name : 'UnknownError' },
    'Unable to connect to the database',
  );
  process.exit(1);
}

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'MailMind AI API is ready');
});

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down API server');
  const forcedExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out');
    server.closeAllConnections();
    void prisma
      .$disconnect()
      .catch(() => undefined)
      .finally(() => process.exit(1));
  }, 10_000);
  forcedExit.unref();
  server.close(async () => {
    clearTimeout(forcedExit);
    try {
      await prisma.$disconnect();
      process.exit(0);
    } catch {
      logger.error('Unable to close the database connection cleanly');
      process.exit(1);
    }
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
