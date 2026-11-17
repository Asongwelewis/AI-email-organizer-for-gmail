import { Router } from 'express';

import {
  classificationReadLimiter,
  preferenceMutationLimiter,
} from '@api/middleware/rateLimiters.js';
import { requireTrustedOrigin } from '@api/middleware/trustedOrigin.js';
import { requireSession } from '@api/sessions/session.middleware.js';
import { asyncHandler } from '@api/utils/asyncHandler.js';
import { watchesController } from './watches.controller.js';

export const watchesRouter = Router();

watchesRouter.use(requireSession);

// Just the keys: what the Inbox needs to draw the eyes and put watched folders first.
watchesRouter.get(
  '/',
  classificationReadLimiter,
  asyncHandler((request, response) => watchesController.keys(request, response)),
);
watchesRouter.post(
  '/',
  preferenceMutationLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => watchesController.add(request, response)),
);
watchesRouter.delete(
  '/:facetKey',
  preferenceMutationLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => watchesController.remove(request, response)),
);
