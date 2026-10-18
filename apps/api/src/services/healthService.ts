import { APP_NAME } from '@mailmind/shared';
import type { HealthResponse } from '@mailmind/shared';
import { schemaStatus, type SchemaStatus } from '@api/database/migrations.js';

const DATABASE_CHECK_TIMEOUT_MS = 5_000;

interface ReadinessResponse {
  status: 'ready' | 'unavailable';
  service: string;
  dependencies: { database: 'up' | 'down'; schema: SchemaStatus };
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
      // Reading the migration bookkeeping is the database round trip `select 1` used to be, and it
      // also says whether this build's migrations reached it. Behind is not ready: the code would
      // answer 500 on every screen that touches a table that is not there.
      const schema = await Promise.race([
        schemaStatus(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('database readiness timeout')),
            DATABASE_CHECK_TIMEOUT_MS,
          );
          timeout.unref();
        }),
      ]);
      return {
        status: schema === 'behind' ? 'unavailable' : 'ready',
        service: APP_NAME,
        dependencies: { database: 'up', schema },
        timestamp: new Date().toISOString(),
      };
    } catch {
      return {
        status: 'unavailable',
        service: APP_NAME,
        dependencies: { database: 'down', schema: 'unknown' },
        timestamp: new Date().toISOString(),
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export const healthService = new HealthService();
