import { Router } from 'express';

import {
  desktopPairingApproveLimiter,
  desktopPairingPollLimiter,
  desktopPairingStartLimiter,
} from '@api/middleware/rateLimiters.js';
import { requireTrustedOrigin } from '@api/middleware/trustedOrigin.js';
import { requireSession } from '@api/sessions/session.middleware.js';
import { asyncHandler } from '@api/utils/asyncHandler.js';
import { desktopPairingController } from './desktop-pairing.controller.js';

export const desktopRouter = Router();

/**
 * Pairing the desktop island (see `desktop-pairing.service.ts`).
 *
 * Starting and polling are unauthenticated, because the island is what has no session yet. What
 * would normally be carried by authentication is carried instead by the trusted-origin check (the
 * island shows AMO's own pages), small budgets, a ten-minute lifetime, and a poll secret only the
 * island holds. Approving is an ordinary signed-in request from the person's browser.
 */
desktopRouter.post(
  '/pairings',
  desktopPairingStartLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => desktopPairingController.start(request, response)),
);
desktopRouter.post(
  '/pairings/complete',
  desktopPairingPollLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => desktopPairingController.complete(request, response)),
);
desktopRouter.post(
  '/pairings/approve',
  requireTrustedOrigin,
  requireSession,
  desktopPairingApproveLimiter,
  asyncHandler((request, response) => desktopPairingController.approve(request, response)),
);
