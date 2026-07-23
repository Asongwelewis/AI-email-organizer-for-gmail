import { Router } from 'express';

import { gmailSyncLimiter, authGeneralLimiter } from '@api/middleware/rateLimiters.js';
import { requireTrustedOrigin } from '@api/middleware/trustedOrigin.js';
import { requireSession } from '@api/sessions/session.middleware.js';
import { asyncHandler } from '@api/utils/asyncHandler.js';
import { gmailController } from './gmail.controller.js';

export const gmailRouter = Router();

gmailRouter.use(requireSession);
gmailRouter.get(
  '/profile',
  authGeneralLimiter,
  asyncHandler((req, res) => gmailController.profile(req, res)),
);
gmailRouter.get(
  '/labels',
  authGeneralLimiter,
  asyncHandler((req, res) => gmailController.labels(req, res)),
);
gmailRouter.get(
  '/sync/status',
  authGeneralLimiter,
  asyncHandler((req, res) => gmailController.status(req, res)),
);
gmailRouter.post(
  '/labels/initialize',
  gmailSyncLimiter,
  requireTrustedOrigin,
  asyncHandler((req, res) => gmailController.initializeLabels(req, res)),
);
gmailRouter.post(
  '/sync/initial',
  gmailSyncLimiter,
  requireTrustedOrigin,
  asyncHandler((req, res) => gmailController.initialSync(req, res)),
);
gmailRouter.post(
  '/sync/incremental',
  gmailSyncLimiter,
  requireTrustedOrigin,
  asyncHandler((req, res) => gmailController.incrementalSync(req, res)),
);
