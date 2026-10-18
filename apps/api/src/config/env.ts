import 'dotenv/config';

import { z } from 'zod';

const isTest = process.env['NODE_ENV'] === 'test';
const testKey = Buffer.alloc(32, 7).toString('base64');

const booleanValue = z.preprocess(
  (value) => (typeof value === 'string' ? value.toLowerCase() : value),
  z.enum(['true', 'false']).transform((value) => value === 'true'),
);

const optionalDomain = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional(),
);

const optionalSecret = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional(),
);

const optionalUrl = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().url().optional(),
);

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_VERSION: z.string().min(1).default('mailmind@0.1.0'),
    SENTRY_DSN: optionalUrl,
    SENTRY_ENVIRONMENT: optionalSecret,
    SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),
    SENTRY_DEBUG: booleanValue.default(false),
    PORT: z.coerce.number().int().positive().default(4000),
    WEB_APP_URL: z.string().url(),
    API_BASE_URL: z.string().url(),
    DATABASE_URL: z.string().min(1),
    /**
     * Connections Prisma may hold. Wins over a `connection_limit` in DATABASE_URL, because that
     * parameter used to be the documented way to pin the pool to one connection — and with one,
     * a page load queued behind whatever the nightly run was doing, for up to `pool_timeout`.
     */
    DATABASE_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(50).optional(),
    /**
     * How often an idle API runs `select 1`, in seconds; 0 turns it off. The pooler drops a
     * connection nobody has used for a while, and the first request after that paid for opening
     * a new one — measured at 14 seconds on one `/auth/me`. It never wakes a sleeping instance:
     * a timer inside the process is not inbound traffic.
     */
    DATABASE_HEARTBEAT_SECONDS: z.coerce.number().int().min(0).max(3600).default(240),
    /**
     * Apply pending migrations during boot. Defaults to on in production and off everywhere else,
     * so a developer's `npm run dev` never migrates whatever database their .env points at.
     */
    MIGRATE_ON_START: booleanValue.optional(),
    GOOGLE_CLIENT_ID: z.string().min(1),
    GOOGLE_CLIENT_SECRET: z.string().min(1),
    GOOGLE_LOGIN_REDIRECT_URI: z.string().url(),
    GOOGLE_GMAIL_REDIRECT_URI: z.string().url(),
    SESSION_SECRET: z.string().min(16),
    TOKEN_ENCRYPTION_KEY: z.string().min(1),
    TOKEN_ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive(),
    COOKIE_SECURE: booleanValue,
    COOKIE_DOMAIN: optionalDomain,
    COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
    /**
     * How long a session survives without being used. Sliding: every day it is used pushes the
     * expiry this far ahead again, so nobody who opens the app is ever logged out by the calendar.
     */
    REFRESH_SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
    /**
     * The hard ceiling, counted from sign-in, that no amount of use extends. A stolen cookie that
     * keeps being used would otherwise stay valid forever.
     */
    SESSION_MAX_LIFETIME_DAYS: z.coerce.number().int().positive().default(90),
    OAUTH_STATE_TTL_MINUTES: z.coerce.number().int().positive().default(10),
    AUTH_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().default(10),
    AUTH_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(30),
    GMAIL_SYNC_PAGE_SIZE: z.coerce.number().int().min(1).max(500).default(100),
    GMAIL_SYNC_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(10),
    GMAIL_SYNC_MAX_RETRIES: z.coerce.number().int().min(0).max(8).default(3),
    GMAIL_SYNC_RETRY_BASE_MS: z.coerce.number().int().min(10).max(30_000).default(250),
    GMAIL_SYNC_LEASE_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    /**
     * Whether MailMind may write labels into the mailbox at all.
     *
     * Off by default, because the PWA is the product and Gmail is the source, not the store. The
     * deep link that opens a message addresses it by id and resolves whether it is filed, archived
     * or still in the inbox, so it has never needed a label — labelling buys organisation visible
     * inside the Gmail app, and costs 150 nested labels in the sidebar and one `messages.modify`
     * per message per run.
     *
     * The filing code is not gone. It is the export path for someone who does want their mail
     * labelled in Gmail, and this is how they ask for it.
     */
    GMAIL_WRITE_ENABLED: booleanValue.default(false),
    // One planning call reads a sample of stored metadata. Depth, leaf count, and the minimum
    // messages per folder are structural invariants and live in the planner, not in config.
    TAXONOMY_SAMPLE_SIZE: z.coerce.number().int().min(20).max(2000).default(500),
    TAXONOMY_LOOKBACK_DAYS: z.coerce.number().int().min(7).max(3650).default(365),
    TAXONOMY_MAX_MESSAGES: z.coerce.number().int().min(50).max(20000).default(5000),
    TAXONOMY_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1000).max(64000).default(16000),
    // Facet vocabulary design reads far more mail than the tree planner: the point is to find the
    // shape of the mail that came back NONE, so the population is the whole mailbox and the sample
    // is stratified across it. The per-domain cap is a hard ceiling rather than a target — it is
    // what keeps a sender with fourteen invoices visible beside a newsletter that sends daily.
    // Its own lookback rather than the tree planner's: the vocabulary has to cover every message
    // the classifier will ever be asked about, so the default reaches back over the whole mailbox
    // instead of the recent slice a folder tree is designed from.
    FACET_LOOKBACK_DAYS: z.coerce.number().int().min(7).max(3650).default(3650),
    FACET_MAX_MESSAGES: z.coerce.number().int().min(50).max(50_000).default(20_000),
    FACET_SAMPLE_SIZE: z.coerce.number().int().min(20).max(4000).default(700),
    FACET_SAMPLE_PER_DOMAIN_CAP: z.coerce.number().int().min(1).max(50).default(4),
    /** Share of the sample drawn from mail the current classifier could not file. */
    FACET_SAMPLE_UNFILED_SHARE: z.coerce.number().min(0).max(1).default(0.8),
    FACET_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1000).max(64000).default(16000),
    AUTOMATION_ENABLED: booleanValue.default(true),
    /**
     * The hours, in UTC, a FULL run starts: the backlog, re-classification, and filing when the
     * Gmail export is on. Comma-separated, e.g. "2,14". New mail does not wait for these — the
     * watcher below picks it up within a minute.
     */
    AUTOMATION_FULL_RUN_HOURS_UTC: z
      .string()
      .optional()
      .transform((value, context) => {
        if (value === undefined || value.trim() === '') return undefined;
        const hours = value.split(',').map((part) => Number(part.trim()));
        if (hours.some((hour) => !Number.isInteger(hour) || hour < 0 || hour > 23)) {
          context.addIssue({ code: 'custom', message: 'must be hours 0-23, comma-separated' });
          return z.NEVER;
        }
        return [...new Set(hours)].sort((left, right) => left - right);
      }),
    /**
     * The single daily hour this used to be. Read only so the scheduler can say at boot that it
     * is ignored: the old .env.example set it to 2, and honouring a copied default would quietly
     * keep a deployment at one full run a day after the move to two.
     */
    AUTOMATION_SCHEDULE_HOUR_UTC: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.coerce.number().int().min(0).max(23).optional(),
    ),
    AUTOMATION_POLL_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(60).default(15),
    /**
     * How often the watcher asks Gmail whether anything changed, in seconds; 0 turns it off. The
     * question is one `users.getProfile` call and nothing else happens when the answer is no, so
     * once a minute is cheap — Gmail allows 250 quota units per user per second.
     */
    AUTOMATION_CHECK_INTERVAL_SECONDS: z.coerce
      .number()
      .int()
      .refine((value) => value === 0 || (value >= 30 && value <= 3600), {
        message: 'must be 0 or between 30 and 3600',
      })
      .default(60),
    /**
     * New mail the rules could not settle waits for Gemini until this many are queued or the
     * oldest has waited AUTOMATION_CLASSIFY_MAX_WAIT_MINUTES, so one call sorts several messages
     * instead of one each — the free tier caps requests per day, not messages.
     */
    AUTOMATION_CLASSIFY_BATCH_THRESHOLD: z.coerce.number().int().min(1).max(25).default(10),
    AUTOMATION_CLASSIFY_MAX_WAIT_MINUTES: z.coerce.number().int().min(0).max(120).default(5),
    /**
     * How often the API requests its own public /health, in minutes; 0 turns it off. The free
     * plan sleeps after 15 minutes without INBOUND traffic, and a timer inside the process is not
     * inbound — a request to API_BASE_URL goes out through Render's edge and comes back in, which
     * is. Production only.
     */
    KEEP_AWAKE_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(14).default(10),
    AUTOMATION_LEASE_SECONDS: z.coerce.number().int().min(60).max(7200).default(1800),
    AUTOMATION_BATCH_SIZE: z.coerce.number().int().min(1).max(25).default(10),
    AUTOMATION_MAX_MESSAGES_PER_RUN: z.coerce.number().int().min(1).max(1000).default(250),
    // Caps approved LEAF folders: the vocabulary automation classifies into. The default
    // matches the planner's 40-leaf ceiling so an approved tree always fits.
    AUTOMATION_MAX_LABELS: z.coerce.number().int().min(1).max(200).default(40),
    // Daily, across every run. Sized for mail that arrives all day and is sorted as it lands:
    // roughly 1,500 messages a day at ~600 input tokens per message including the instructions.
    AUTOMATION_MAX_INPUT_TOKENS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(10_000_000)
      .default(1_000_000),
    AUTOMATION_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(100).max(1_000_000).default(100_000),
    AUTOMATION_MAX_COST_MICRO_USD: z.coerce
      .number()
      .int()
      .min(1000)
      .max(20_000_000_000)
      .default(5_000_000),
    AUTOMATION_CONFIDENCE_THRESHOLD: z.coerce.number().min(0.5).max(1).default(0.8),
    AUTOMATION_PATTERN_MIN_SAMPLES: z.coerce.number().int().min(1).max(100).default(2),
    AUTOMATION_PATTERN_MIN_CONFIDENCE: z.coerce.number().min(0.5).max(1).default(0.9),
    AUTOMATION_MAX_ACTION_RETRIES: z.coerce.number().int().min(1).max(10).default(3),
    GEMINI_API_KEY: optionalSecret,
    // The alias tracks the current Flash-Lite. Pinned ids get retired: gemini-2.5-flash-lite
    // started returning 404 "no longer available to new users" and broke the scheduler.
    GEMINI_MODEL: z.string().min(1).max(200).default('gemini-flash-lite-latest'),
    GEMINI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
    GEMINI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
    // The free tier allows 15 requests per minute, so 4000ms between requests sits exactly on
    // that ceiling. Pacing is the primary rate-limit strategy; 429 retries are the fallback.
    GEMINI_MIN_REQUEST_INTERVAL_MS: z.coerce.number().int().min(0).max(60_000).default(4000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(0),
  })
  .transform((value, context) => {
    let tokenEncryptionKey: Buffer;
    try {
      tokenEncryptionKey = Buffer.from(value.TOKEN_ENCRYPTION_KEY, 'base64');
    } catch {
      tokenEncryptionKey = Buffer.alloc(0);
    }
    if (tokenEncryptionKey.length !== 32) {
      context.addIssue({
        code: 'custom',
        path: ['TOKEN_ENCRYPTION_KEY'],
        message: 'must decode to exactly 32 bytes',
      });
      return z.NEVER;
    }
    if (value.COOKIE_SAME_SITE === 'none' && !value.COOKIE_SECURE) {
      context.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'must be true when COOKIE_SAME_SITE is none',
      });
      return z.NEVER;
    }
    if (value.NODE_ENV === 'production' && !value.COOKIE_SECURE) {
      context.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'must be true in production',
      });
      return z.NEVER;
    }
    // The SPA (Vercel) and API (Render) are on different sites, so anything but
    // 'none' means the browser never sends the session cookie and login fails
    // silently. Only a shared parent domain makes a lax or strict cookie viable.
    if (
      value.NODE_ENV === 'production' &&
      value.COOKIE_SAME_SITE !== 'none' &&
      !value.COOKIE_DOMAIN
    ) {
      context.addIssue({
        code: 'custom',
        path: ['COOKIE_SAME_SITE'],
        message: "must be 'none' in production unless COOKIE_DOMAIN is set",
      });
      return z.NEVER;
    }
    if (value.SESSION_MAX_LIFETIME_DAYS < value.REFRESH_SESSION_TTL_DAYS) {
      context.addIssue({
        code: 'custom',
        path: ['SESSION_MAX_LIFETIME_DAYS'],
        message: 'must be at least REFRESH_SESSION_TTL_DAYS',
      });
      return z.NEVER;
    }
    return {
      ...value,
      AUTOMATION_FULL_RUN_HOURS_UTC: value.AUTOMATION_FULL_RUN_HOURS_UTC ?? [2, 14],
      MIGRATE_ON_START: value.MIGRATE_ON_START ?? value.NODE_ENV === 'production',
      TOKEN_ENCRYPTION_KEY_BYTES: tokenEncryptionKey,
    };
  });

const testDefaults = isTest
  ? {
      WEB_APP_URL: 'https://mailmindai.tech',
      API_BASE_URL: 'https://ai-email-organizer-for-gmail.onrender.com',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      GOOGLE_CLIENT_ID: 'test-google-client-id',
      GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
      GOOGLE_LOGIN_REDIRECT_URI:
        'https://ai-email-organizer-for-gmail.onrender.com/api/auth/google/callback',
      GOOGLE_GMAIL_REDIRECT_URI:
        'https://ai-email-organizer-for-gmail.onrender.com/api/integrations/google/callback',
      SESSION_SECRET: 'test-session-secret-long-enough',
      TOKEN_ENCRYPTION_KEY: testKey,
      TOKEN_ENCRYPTION_KEY_VERSION: '1',
      COOKIE_SECURE: 'false',
    }
  : {};

const candidate = {
  ...testDefaults,
  ...process.env,
  APP_VERSION: process.env['APP_VERSION'] ?? process.env['SENTRY_RELEASE'] ?? 'mailmind@0.1.0',
  WEB_APP_URL: process.env['WEB_APP_URL'] ?? process.env['WEB_URL'] ?? testDefaults.WEB_APP_URL,
};

const parsed = environmentSchema.safeParse(candidate);

if (!parsed.success) {
  const fields = [
    ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'environment')),
  ];
  throw new Error(`Invalid API configuration. Check: ${fields.join(', ')}`);
}

export const env = parsed.data;
