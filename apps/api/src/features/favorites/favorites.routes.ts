import { Router } from 'express';

import {
  classificationReadLimiter,
  preferenceMutationLimiter,
} from '@api/middleware/rateLimiters.js';
import { requireTrustedOrigin } from '@api/middleware/trustedOrigin.js';
import { requireSession } from '@api/sessions/session.middleware.js';
import { asyncHandler } from '@api/utils/asyncHandler.js';
import { favoritesController } from './favorites.controller.js';

export const favoritesRouter = Router();

favoritesRouter.use(requireSession);

favoritesRouter.get(
  '/',
  classificationReadLimiter,
  asyncHandler((request, response) => favoritesController.list(request, response)),
);
// Just the keys: what the Inbox needs to fill in the stars on its folder tiles.
favoritesRouter.get(
  '/keys',
  classificationReadLimiter,
  asyncHandler((request, response) => favoritesController.keys(request, response)),
);
favoritesRouter.post(
  '/',
  preferenceMutationLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => favoritesController.add(request, response)),
);
favoritesRouter.delete(
  '/:facetKey',
  preferenceMutationLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => favoritesController.remove(request, response)),
);
