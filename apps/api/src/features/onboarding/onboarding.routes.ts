import { Router } from 'express';

import { activityPollLimiter, preferenceMutationLimiter } from '@api/middleware/rateLimiters.js';
import { requireTrustedOrigin } from '@api/middleware/trustedOrigin.js';
import { requireSession } from '@api/sessions/session.middleware.js';
import { asyncHandler } from '@api/utils/asyncHandler.js';
import { onboardingController } from './onboarding.controller.js';

export const onboardingRouter = Router();

onboardingRouter.use(requireSession);

// Polled every two seconds while the progress bar is on screen.
onboardingRouter.get(
  '/',
  activityPollLimiter,
  asyncHandler((request, response) => onboardingController.status(request, response)),
);
onboardingRouter.post(
  '/start',
  preferenceMutationLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => onboardingController.start(request, response)),
);
