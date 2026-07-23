import { APP_NAME } from '@mailmind/shared';
import type { HealthResponse } from '@mailmind/shared';
import { prisma } from '@api/database/prisma.js';

const DATABASE_CHECK_TIMEOUT_MS = 5_000;

interface ReadinessResponse {
  status: 'ready' | 'unavailable';
  service: string;
  dependencies: { database: 'up' | 'down' };
  timestamp: string;
}

export class HealthService {
  getStatus(): HealthResponse {
    return {
      status: 'ok',
      service: APP_NAME,
      timestamp: new Date().toISOString(),
    };
  }

  async getReadiness(): Promise<ReadinessResponse> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        prisma.$queryRaw`select 1`,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('database readiness timeout')),
            DATABASE_CHECK_TIMEOUT_MS,
          );
          timeout.unref();
        }),
      ]);
      return {
        status: 'ready',
        service: APP_NAME,
        dependencies: { database: 'up' },
        timestamp: new Date().toISOString(),
      };
    } catch {
      return {
        status: 'unavailable',
        service: APP_NAME,
        dependencies: { database: 'down' },
        timestamp: new Date().toISOString(),
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export const healthService = new HealthService();
