import { APP_NAME } from '@mailmind/shared';
import type { HealthResponse } from '@mailmind/shared';

export class HealthService {
  getStatus(): HealthResponse {
    return {
      status: 'ok',
      service: APP_NAME,
      timestamp: new Date().toISOString(),
    };
  }
}

export const healthService = new HealthService();
