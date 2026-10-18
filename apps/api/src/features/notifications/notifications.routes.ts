import { Router } from 'express';

import { activityPollLimiter, preferenceMutationLimiter } from '@api/middleware/rateLimiters.js';
import { requireTrustedOrigin } from '@api/middleware/trustedOrigin.js';
import { requireSession } from '@api/sessions/session.middleware.js';
import { asyncHandler } from '@api/utils/asyncHandler.js';
import { notificationsController } from './notifications.controller.js';

export const notificationsRouter = Router();

notificationsRouter.use(requireSession);

// Polled every minute by every open screen, so it takes the polling budget.
notificationsRouter.get(
  '/',
  activityPollLimiter,
  asyncHandler((request, response) => notificationsController.list(request, response)),
);
notificationsRouter.post(
  '/read',
  preferenceMutationLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => notificationsController.markRead(request, response)),
);
notificationsRouter.get(
  '/push',
  activityPollLimiter,
  asyncHandler((request, response) => notificationsController.pushConfig(request, response)),
);
notificationsRouter.post(
  '/push/subscribe',
  preferenceMutationLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => notificationsController.subscribe(request, response)),
);
notificationsRouter.post(
  '/push/unsubscribe',
  preferenceMutationLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => notificationsController.unsubscribe(request, response)),
);
