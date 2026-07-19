import type { Request, Response } from 'express';

import { healthService } from '@api/services/healthService.js';

export class HealthController {
  getHealth(_request: Request, response: Response): void {
    response.status(200).json(healthService.getStatus());
  }
}

export const healthController = new HealthController();
