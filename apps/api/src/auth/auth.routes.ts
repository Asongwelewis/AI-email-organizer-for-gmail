import { Router } from 'express';

import { asyncHandler } from '@api/utils/asyncHandler.js';
import { requireSession } from '@api/sessions/session.middleware.js';
import {
  authGeneralLimiter,
  oauthCallbackLimiter,
  oauthStartLimiter,
  sessionRefreshLimiter,
} from '@api/middleware/rateLimiters.js';
import { authController } from './auth.controller.js';
import { requireTrustedOrigin } from '@api/middleware/trustedOrigin.js';

export const authRouter = Router();

authRouter.get(
  '/google',
  oauthStartLimiter,
  asyncHandler((req, res) => authController.startGoogle(req, res)),
);
authRouter.get(
  '/google/callback',
  oauthCallbackLimiter,
  asyncHandler((req, res) => authController.googleCallback(req, res)),
);
authRouter.get(
  '/me',
  authGeneralLimiter,
  requireSession,
  asyncHandler((req, res) => authController.me(req, res)),
);
authRouter.post(
  '/refresh',
  sessionRefreshLimiter,
  requireTrustedOrigin,
  asyncHandler((req, res) => authController.refresh(req, res)),
);
authRouter.post(
  '/logout',
  authGeneralLimiter,
  requireTrustedOrigin,
  asyncHandler((req, res) => authController.logout(req, res)),
);
authRouter.post(
  '/logout-all',
  authGeneralLimiter,
  requireTrustedOrigin,
  requireSession,
  asyncHandler((req, res) => authController.logoutAll(req, res)),
);
