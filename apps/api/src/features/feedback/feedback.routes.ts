import { Router } from 'express';

import { feedbackLimiter } from '@api/middleware/rateLimiters.js';
import { requireTrustedOrigin } from '@api/middleware/trustedOrigin.js';
import { asyncHandler } from '@api/utils/asyncHandler.js';
import { feedbackController } from './feedback.controller.js';

export const feedbackRouter = Router();

/**
 * The only unauthenticated write in the API.
 *
 * No `requireSession`, because a visitor who was handed the link is exactly who this is for — the
 * controller attributes a session when one happens to be present. Everything that would normally
 * be carried by authentication is carried by the two guards instead: a shared, deliberately small
 * rate limit, and the trusted-origin check that keeps a browser on some other site from posting
 * through somebody who is signed in here.
 */
feedbackRouter.post(
  '/',
  feedbackLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => feedbackController.submit(request, response)),
);
