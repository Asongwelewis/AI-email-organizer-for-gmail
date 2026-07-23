import { Router } from 'express';

import { healthRouter } from './healthRoutes.js';
import { healthController } from '@api/controllers/healthController.js';
import { authRouter } from '@api/auth/auth.routes.js';
import { googleIntegrationRouter } from '@api/integrations/google/google-integration.routes.js';
import { gmailRouter } from '@api/integrations/gmail/gmail.routes.js';

export const apiRouter = Router();

apiRouter.use('/health', healthRouter);
apiRouter.get(
  '/ready',
  (request, response) => void healthController.getReadiness(request, response),
);
apiRouter.use('/auth', authRouter);
apiRouter.use('/integrations/google', googleIntegrationRouter);
apiRouter.use('/gmail', gmailRouter);
