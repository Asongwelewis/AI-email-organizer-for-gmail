import { Router } from 'express';

import { healthController } from '@api/controllers/healthController.js';

export const healthRouter = Router();

healthRouter.get('/', (request, response) => healthController.getHealth(request, response));
healthRouter.get(
  '/ready',
  (request, response) => void healthController.getReadiness(request, response),
);
