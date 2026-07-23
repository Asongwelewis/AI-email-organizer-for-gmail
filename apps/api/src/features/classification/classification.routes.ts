import { Router } from 'express';

import {
  classificationMutationLimiter,
  classificationReadLimiter,
} from '@api/middleware/rateLimiters.js';
import { requireTrustedOrigin } from '@api/middleware/trustedOrigin.js';
import { requireSession } from '@api/sessions/session.middleware.js';
import { asyncHandler } from '@api/utils/asyncHandler.js';
import { classificationController } from './classification.controller.js';

export const classificationRouter = Router();

classificationRouter.use(requireSession);
classificationRouter.get(
  '/status',
  classificationReadLimiter,
  asyncHandler((request, response) => classificationController.status(request, response)),
);
classificationRouter.get(
  '/results',
  classificationReadLimiter,
  asyncHandler((request, response) => classificationController.results(request, response)),
);
classificationRouter.get(
  '/results/:id',
  classificationReadLimiter,
  asyncHandler((request, response) => classificationController.result(request, response)),
);
classificationRouter.post(
  '/run',
  classificationMutationLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => classificationController.run(request, response)),
);
classificationRouter.post(
  '/messages/:messageId/reclassify',
  classificationMutationLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => classificationController.reclassify(request, response)),
);
classificationRouter.post(
  '/results/:id/correct',
  classificationMutationLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => classificationController.correct(request, response)),
);
