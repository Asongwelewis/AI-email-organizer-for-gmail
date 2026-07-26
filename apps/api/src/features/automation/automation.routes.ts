import { Router } from 'express';

import {
  classificationMutationLimiter,
  classificationReadLimiter,
} from '@api/middleware/rateLimiters.js';
import { requireTrustedOrigin } from '@api/middleware/trustedOrigin.js';
import { requireSession } from '@api/sessions/session.middleware.js';
import { asyncHandler } from '@api/utils/asyncHandler.js';
import { automationController } from './automation.controller.js';

export const automationRouter = Router();

automationRouter.use(requireSession);
automationRouter.get(
  '/status',
  classificationReadLimiter,
  asyncHandler((request, response) => automationController.status(request, response)),
);
automationRouter.get(
  '/review',
  classificationReadLimiter,
  asyncHandler((request, response) => automationController.review(request, response)),
);
automationRouter.post(
  '/run',
  classificationMutationLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => automationController.run(request, response)),
);
automationRouter.post(
  '/review/:id/approve',
  classificationMutationLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => automationController.approve(request, response)),
);
automationRouter.post(
  '/review/:id/skip',
  classificationMutationLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => automationController.skip(request, response)),
);
