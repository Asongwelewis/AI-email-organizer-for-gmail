import { Router } from 'express';

import { activityPollLimiter } from '@api/middleware/rateLimiters.js';
import { requireSession } from '@api/sessions/session.middleware.js';
import { asyncHandler } from '@api/utils/asyncHandler.js';
import { activityController } from './activity.controller.js';

export const activityRouter = Router();

activityRouter.use(requireSession);
activityRouter.get(
  '/runs',
  activityPollLimiter,
  asyncHandler((request, response) => activityController.list(request, response)),
);
activityRouter.get(
  '/runs/:id',
  activityPollLimiter,
  asyncHandler((request, response) => activityController.detail(request, response)),
);
