import { Router } from 'express';

import {
  classificationMutationLimiter,
  classificationReadLimiter,
  labelsMutationLimiter,
} from '@api/middleware/rateLimiters.js';
import { requireTrustedOrigin } from '@api/middleware/trustedOrigin.js';
import { requireSession } from '@api/sessions/session.middleware.js';
import { asyncHandler } from '@api/utils/asyncHandler.js';
import { facetsController } from './facets.controller.js';

export const facetsRouter = Router();

facetsRouter.use(requireSession);

/**
 * Reads are pure functions of stored facets — no Gemini call, no Gmail call — so they get the
 * read budget. The two that spend a real quota, and the one that creates labels in someone's
 * mailbox, get the mutation budget and the trusted-origin check.
 */
facetsRouter.get(
  '/pivot',
  classificationReadLimiter,
  asyncHandler((request, response) => facetsController.settings(request, response)),
);
facetsRouter.put(
  '/pivot',
  labelsMutationLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => facetsController.setSettings(request, response)),
);
facetsRouter.get(
  '/messages',
  classificationReadLimiter,
  asyncHandler((request, response) => facetsController.folderMessages(request, response)),
);
facetsRouter.get(
  '/pivot/plan',
  classificationReadLimiter,
  asyncHandler((request, response) => facetsController.plan(request, response)),
);
facetsRouter.get(
  '/pivot/view',
  classificationReadLimiter,
  asyncHandler((request, response) => facetsController.view(request, response)),
);
// Creates folders in a real mailbox, so it is a mutation in every sense that matters.
facetsRouter.post(
  '/pivot/apply',
  labelsMutationLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => facetsController.apply(request, response)),
);
facetsRouter.post(
  '/classify',
  classificationMutationLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => facetsController.classify(request, response)),
);
facetsRouter.post(
  '/file',
  classificationMutationLimiter,
  requireTrustedOrigin,
  asyncHandler((request, response) => facetsController.file(request, response)),
);
