import { Router } from 'express';

import { healthRouter } from './healthRoutes.js';
import { healthController } from '@api/controllers/healthController.js';
import { authRouter } from '@api/auth/auth.routes.js';
import { googleIntegrationRouter } from '@api/integrations/google/google-integration.routes.js';
import { gmailRouter } from '@api/integrations/gmail/gmail.routes.js';
import { activityRouter } from '@api/features/activity/activity.routes.js';
import { automationRouter } from '@api/features/automation/automation.routes.js';
import { labelsRouter } from '@api/features/labels/labels.routes.js';
import { facetsRouter } from '@api/features/facets/facets.routes.js';

export const apiRouter = Router();

apiRouter.use('/health', healthRouter);
apiRouter.get(
  '/ready',
  (request, response) => void healthController.getReadiness(request, response),
);
apiRouter.use('/auth', authRouter);
apiRouter.use('/integrations/google', googleIntegrationRouter);
apiRouter.use('/gmail', gmailRouter);
apiRouter.use('/labels', labelsRouter);
apiRouter.use('/facets', facetsRouter);
apiRouter.use('/automation', automationRouter);
apiRouter.use('/activity', activityRouter);
