import rateLimit from 'express-rate-limit';

import { env } from '@api/config/env.js';
import { PrismaRateLimitStore } from './rate-limit.store.js';

/**
 * Shared counters cost a database round trip; per-instance counters cost accuracy. Which one a
 * limiter wants depends on what it is guarding.
 *
 * Measured on 27 Aug 2026 against the deployed API: Render and Supabase are not co-located, so a
 * round trip is roughly 100-150ms. The upsert itself is about 2ms — the cost is entirely the trip.
 * Paying it on `activityPollLimiter`, which a client hits every two seconds for the length of a
 * run, is 150ms and one row written per poll to protect a budget of 1,200 requests that exists
 * only to stop a client hammering itself.
 *
 * So: anything that spends a quota, writes to a mailbox, or guards authentication counts across
 * instances, because with N instances a per-instance limit is really N times the limit and that is
 * a real hole in a brute-force or quota-abuse guard. Reads and progress polling stay in memory,
 * where being N times looser costs nothing anybody cares about.
 */
type LimiterScope = 'shared' | 'per-instance';

/**
 * Every shared limiter gets its own store instance, because `init` records that limiter's window —
 * but they all read the same table, so those counters hold across API instances and restarts.
 *
 * Under `NODE_ENV=test` the in-memory store is used throughout. Not to weaken anything: the HTTP
 * contract suites exercise routes with every service mocked and no database in reach, and dragging
 * one in through a rate limiter would make them tests of the store rather than of the routes.
 * `PrismaRateLimitStore` is exercised directly, and against the behaviour that matters — two
 * instances counting one client together — in `rate-limit.test.ts`.
 *
 * `passOnStoreError` is deliberately left at its default of false. A limiter that cannot reach the
 * database is a limiter that is not limiting, and the shared ones guard the OAuth and session
 * endpoints: a brief 500 is the safer failure. Narrowing the shared set also narrows what a
 * database outage can take down with it.
 */
function limiter(limit: number, scope: LimiterScope = 'shared') {
  const shared = scope === 'shared' && env.NODE_ENV !== 'test';
  return rateLimit({
    windowMs: env.AUTH_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    ...(shared ? { store: new PrismaRateLimitStore() } : {}),
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
export const classificationReadLimiter = limiter(
  Math.max(env.AUTH_RATE_LIMIT_MAX_REQUESTS, 30),
  'per-instance',
);
export const classificationMutationLimiter = limiter(
  Math.min(env.AUTH_RATE_LIMIT_MAX_REQUESTS, 10),
);
export const labelsReadLimiter = limiter(
  Math.max(env.AUTH_RATE_LIMIT_MAX_REQUESTS, 30),
  'per-instance',
);
// Progress polling runs at 2s for as long as a run lasts, so this budget is sized per second
// rather than per window. At the default ten-minute window a 30-request cap would 429 a client
// fifteen seconds into a twenty-minute backfill.
export const activityPollLimiter = limiter(
  Math.max(env.AUTH_RATE_LIMIT_MAX_REQUESTS, env.AUTH_RATE_LIMIT_WINDOW_MINUTES * 60 * 2),
  'per-instance',
);
export const labelsMutationLimiter = limiter(Math.min(env.AUTH_RATE_LIMIT_MAX_REQUESTS, 10));
