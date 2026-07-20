import { Router } from 'express';

import { healthRouter } from './healthRoutes.js';
import { authRouter } from '@api/auth/auth.routes.js';
import { googleIntegrationRouter } from '@api/integrations/google/google-integration.routes.js';

export const apiRouter = Router();

apiRouter.use('/health', healthRouter);
apiRouter.use('/auth', authRouter);
apiRouter.use('/integrations/google', googleIntegrationRouter);
