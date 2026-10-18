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
function limiter(name: string, limit: number, scope: LimiterScope = 'shared') {
  const shared = scope === 'shared' && env.NODE_ENV !== 'test';
  return rateLimit({
    windowMs: env.AUTH_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    ...(shared ? { store: new PrismaRateLimitStore(name) } : {}),
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

export const oauthStartLimiter = limiter(
  'oauthStartLimiter',
  Math.min(env.AUTH_RATE_LIMIT_MAX_REQUESTS, 10),
);
export const oauthCallbackLimiter = limiter(
  'oauthCallbackLimiter',
  Math.min(env.AUTH_RATE_LIMIT_MAX_REQUESTS, 20),
);
export const sessionRefreshLimiter = limiter(
  'sessionRefreshLimiter',
  env.AUTH_RATE_LIMIT_MAX_REQUESTS,
);
export const authGeneralLimiter = limiter(
  'authGeneralLimiter',
  Math.max(env.AUTH_RATE_LIMIT_MAX_REQUESTS, 30),
);
/**
 * The reads every page load makes before it can show anything: `GET /auth/me` and the Gmail
 * connection status. In memory, because a database write in front of them was a round trip on
 * the one request a person is staring at a spinner for — and the session token they check is 256
 * random bits, so there is nothing for a per-instance budget to let anybody guess.
 */
export const sessionReadLimiter = limiter(
  'sessionReadLimiter',
  Math.max(env.AUTH_RATE_LIMIT_MAX_REQUESTS, 60),
  'per-instance',
);
export const gmailSyncLimiter = limiter(
  'gmailSyncLimiter',
  Math.min(env.AUTH_RATE_LIMIT_MAX_REQUESTS, 10),
);
export const classificationReadLimiter = limiter(
  'classificationReadLimiter',
  Math.max(env.AUTH_RATE_LIMIT_MAX_REQUESTS, 30),
  'per-instance',
);
export const classificationMutationLimiter = limiter(
  'classificationMutationLimiter',
  Math.min(env.AUTH_RATE_LIMIT_MAX_REQUESTS, 10),
);
/**
 * Folder logos: one request per brand folder on screen, then the browser's cache for a week. The
 * read budget of thirty would run out on a first visit to a mailbox with forty brands.
 */
export const iconLimiter = limiter(
  'iconLimiter',
  Math.max(env.AUTH_RATE_LIMIT_MAX_REQUESTS, 600),
  'per-instance',
);
export const labelsReadLimiter = limiter(
  'labelsReadLimiter',
  Math.max(env.AUTH_RATE_LIMIT_MAX_REQUESTS, 30),
  'per-instance',
);
// Progress polling runs at 2s for as long as a run lasts, so this budget is sized per second
// rather than per window. At the default ten-minute window a 30-request cap would 429 a client
// fifteen seconds into a twenty-minute backfill.
export const activityPollLimiter = limiter(
  'activityPollLimiter',
  Math.max(env.AUTH_RATE_LIMIT_MAX_REQUESTS, env.AUTH_RATE_LIMIT_WINDOW_MINUTES * 60 * 2),
  'per-instance',
);
/**
 * Starring folders and marking notifications read: small writes to a person's own rows, made by
 * tapping. The shared ten-per-window mutation budget would refuse the eleventh star.
 */
export const preferenceMutationLimiter = limiter(
  'preferenceMutationLimiter',
  Math.max(env.AUTH_RATE_LIMIT_MAX_REQUESTS, 300),
  'per-instance',
);
export const labelsMutationLimiter = limiter(
  'labelsMutationLimiter',
  Math.min(env.AUTH_RATE_LIMIT_MAX_REQUESTS, 10),
);

/**
 * The only limiter in front of an unauthenticated write, and the smallest.
 *
 * Shared, without hesitation: with the counter per-instance, the cost of getting past it is a
 * retry until the load balancer picks a different process. Five per window is generous for a
 * person with something to say and tedious for anything filling the table.
 */
export const feedbackLimiter = limiter(
  'feedbackLimiter',
  Math.min(env.AUTH_RATE_LIMIT_MAX_REQUESTS, 5),
);
