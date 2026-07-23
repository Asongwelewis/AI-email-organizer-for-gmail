import { Router } from 'express';

import {
  authGeneralLimiter,
  oauthCallbackLimiter,
  oauthStartLimiter,
} from '@api/middleware/rateLimiters.js';
import { requireSession } from '@api/sessions/session.middleware.js';
import { asyncHandler } from '@api/utils/asyncHandler.js';
import { googleIntegrationController } from './google-integration.controller.js';
import { requireTrustedOrigin } from '@api/middleware/trustedOrigin.js';

export const googleIntegrationRouter = Router();

googleIntegrationRouter.get(
  '/connect',
  oauthStartLimiter,
  requireSession,
  asyncHandler((req, res) => googleIntegrationController.connect(req, res)),
);
googleIntegrationRouter.get(
  '/callback',
  oauthCallbackLimiter,
  asyncHandler((req, res) => googleIntegrationController.callback(req, res)),
);
googleIntegrationRouter.get(
  '/status',
  authGeneralLimiter,
  requireSession,
  asyncHandler((req, res) => googleIntegrationController.status(req, res)),
);
googleIntegrationRouter.post(
  '/disconnect',
  authGeneralLimiter,
  requireTrustedOrigin,
  requireSession,
  asyncHandler((req, res) => googleIntegrationController.disconnect(req, res)),
);
