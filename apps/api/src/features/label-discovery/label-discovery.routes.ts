import { Router } from 'express';

import {
  labelDiscoveryMutationLimiter,
  labelDiscoveryReadLimiter,
} from '@api/middleware/rateLimiters.js';
import { requireTrustedOrigin } from '@api/middleware/trustedOrigin.js';
import { requireSession } from '@api/sessions/session.middleware.js';
import { asyncHandler } from '@api/utils/asyncHandler.js';
import { labelDiscoveryController } from './label-discovery.controller.js';

export const labelDiscoveryRouter = Router();

labelDiscoveryRouter.use(requireSession);
labelDiscoveryRouter.get(
  '/status',
  labelDiscoveryReadLimiter,
  asyncHandler((request, response) => labelDiscoveryController.status(request, response)),
);
labelDiscoveryRouter.get(
  '/candidates',
  labelDiscoveryReadLimiter,
  asyncHandler((request, response) => labelDiscoveryController.candidates(request, response)),
);
labelDiscoveryRouter.get(
  '/candidates/:id',
  labelDiscoveryReadLimiter,
  asyncHandler((request, response) => labelDiscoveryController.candidate(request, response)),
);
labelDiscoveryRouter.post(
  '/run',
  labelDiscoveryMutationLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => labelDiscoveryController.run(request, response)),
);
labelDiscoveryRouter.post(
  '/candidates/:id/approve',
  labelDiscoveryMutationLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => labelDiscoveryController.approve(request, response)),
);
labelDiscoveryRouter.post(
  '/candidates/:id/reject',
  labelDiscoveryMutationLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => labelDiscoveryController.reject(request, response)),
);
labelDiscoveryRouter.post(
  '/candidates/:id/defer',
  labelDiscoveryMutationLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => labelDiscoveryController.defer(request, response)),
);
labelDiscoveryRouter.post(
  '/candidates/:id/merge',
  labelDiscoveryMutationLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => labelDiscoveryController.merge(request, response)),
);
