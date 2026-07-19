import { Router } from 'express';

import { healthRouter } from './healthRoutes.js';

export const apiRouter = Router();

apiRouter.use('/health', healthRouter);
