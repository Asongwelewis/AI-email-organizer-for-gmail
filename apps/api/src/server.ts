import { app } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { prisma } from './database/prisma.js';

try {
  await prisma.$connect();
  logger.info('Database connection established');
} catch (error) {
  logger.fatal({ err: error }, 'Unable to connect to the database');
  process.exit(1);
}

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'MailMind AI API is ready');
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutting down API server');
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
