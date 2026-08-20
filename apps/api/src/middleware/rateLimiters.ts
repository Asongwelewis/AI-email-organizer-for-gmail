import rateLimit from 'express-rate-limit';

import { env } from '@api/config/env.js';

function limiter(limit: number) {
  return rateLimit({
    windowMs: env.AUTH_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_request, response) => {
      response.status(429).json({
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests. Please try again later.',
        },
      });
    },
  });
}

export const oauthStartLimiter = limiter(Math.min(env.AUTH_RATE_LIMIT_MAX_REQUESTS, 10));
export const oauthCallbackLimiter = limiter(Math.min(env.AUTH_RATE_LIMIT_MAX_REQUESTS, 20));
export const sessionRefreshLimiter = limiter(env.AUTH_RATE_LIMIT_MAX_REQUESTS);
export const authGeneralLimiter = limiter(Math.max(env.AUTH_RATE_LIMIT_MAX_REQUESTS, 30));
export const gmailSyncLimiter = limiter(Math.min(env.AUTH_RATE_LIMIT_MAX_REQUESTS, 10));
export const classificationReadLimiter = limiter(Math.max(env.AUTH_RATE_LIMIT_MAX_REQUESTS, 30));
export const classificationMutationLimiter = limiter(
  Math.min(env.AUTH_RATE_LIMIT_MAX_REQUESTS, 10),
);
export const labelsReadLimiter = limiter(Math.max(env.AUTH_RATE_LIMIT_MAX_REQUESTS, 30));
// Progress polling runs at 2s for as long as a run lasts, so this budget is sized per second
// rather than per window. At the default ten-minute window a 30-request cap would 429 a client
// fifteen seconds into a twenty-minute backfill.
export const activityPollLimiter = limiter(
  Math.max(env.AUTH_RATE_LIMIT_MAX_REQUESTS, env.AUTH_RATE_LIMIT_WINDOW_MINUTES * 60 * 2),
);
export const labelsMutationLimiter = limiter(Math.min(env.AUTH_RATE_LIMIT_MAX_REQUESTS, 10));
