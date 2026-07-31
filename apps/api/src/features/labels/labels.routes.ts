import { Router } from 'express';

import { labelsMutationLimiter, labelsReadLimiter } from '@api/middleware/rateLimiters.js';
import { requireTrustedOrigin } from '@api/middleware/trustedOrigin.js';
import { requireSession } from '@api/sessions/session.middleware.js';
import { asyncHandler } from '@api/utils/asyncHandler.js';
import { labelsController } from './labels.controller.js';

export const labelsRouter = Router();

labelsRouter.use(requireSession);
labelsRouter.get(
  '/',
  labelsReadLimiter,
  asyncHandler((request, response) => labelsController.list(request, response)),
);
labelsRouter.post(
  '/propose',
  labelsMutationLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => labelsController.propose(request, response)),
);
labelsRouter.post(
  '/confirm',
  labelsMutationLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => labelsController.confirm(request, response)),
);
labelsRouter.patch(
  '/:id',
  labelsMutationLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => labelsController.rename(request, response)),
);
labelsRouter.delete(
  '/:id',
  labelsMutationLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => labelsController.remove(request, response)),
);
