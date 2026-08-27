import rateLimit from 'express-rate-limit';

import { env } from '@api/config/env.js';
import { PrismaRateLimitStore } from './rate-limit.store.js';

/**
 * Every limiter gets its own store instance, because `init` records that limiter's window — but
 * they all read the same table, so the counters hold across API instances and across restarts.
 *
 * Under `NODE_ENV=test` the default in-memory store is used instead. Not to weaken anything: the
 * HTTP contract suites exercise routes with every service mocked and no database in reach, and
 * dragging one in through a rate limiter would make them tests of the store rather than of the
 * routes. `PrismaRateLimitStore` is exercised directly, and against the behaviour that matters —
 * two instances counting one client together — in `rate-limit.test.ts`.
 *
 * `passOnStoreError` is deliberately left at its default of false. A limiter that cannot reach the
 * database is a limiter that is not limiting, and these guard the OAuth and session endpoints: a
 * brief 500 is the safer failure.
 */
function limiter(limit: number) {
  return rateLimit({
    windowMs: env.AUTH_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    ...(env.NODE_ENV === 'test' ? {} : { store: new PrismaRateLimitStore() }),
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
