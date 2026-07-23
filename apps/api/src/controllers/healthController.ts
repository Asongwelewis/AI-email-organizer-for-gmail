import type { Request, Response } from 'express';

import { healthService } from '@api/services/healthService.js';

export class HealthController {
  getHealth(_request: Request, response: Response): void {
    response.status(200).json(healthService.getStatus());
  }

  async getReadiness(_request: Request, response: Response): Promise<void> {
    const readiness = await healthService.getReadiness();
    response.status(readiness.status === 'ready' ? 200 : 503).json(readiness);
  }
}

export const healthController = new HealthController();
