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
    ACCESS_SESSION_TTL_MINUTES: z.coerce.number().int().positive().default(15),
    REFRESH_SESSION_TTL_DAYS: z.coerce.number().int().positive().default(14),
    OAUTH_STATE_TTL_MINUTES: z.coerce.number().int().positive().default(10),
    AUTH_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().default(10),
    AUTH_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(30),
    GMAIL_SYNC_PAGE_SIZE: z.coerce.number().int().min(1).max(500).default(100),
    GMAIL_SYNC_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(10),
    GMAIL_SYNC_MAX_RETRIES: z.coerce.number().int().min(0).max(8).default(3),
    GMAIL_SYNC_RETRY_BASE_MS: z.coerce.number().int().min(10).max(30_000).default(250),
    GMAIL_SYNC_LEASE_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    DYNAMIC_LABEL_DISCOVERY_ENABLED: booleanValue.default(true),
    DYNAMIC_LABEL_MIN_MESSAGES: z.coerce.number().int().min(3).max(100).default(3),
    DYNAMIC_LABEL_LOOKBACK_DAYS: z.coerce.number().int().min(7).max(365).default(90),
    DYNAMIC_LABEL_MIN_CONFIDENCE: z.coerce.number().min(0.5).max(1).default(0.75),
    DYNAMIC_LABEL_MIN_CATEGORY_AGREEMENT: z.coerce.number().min(0.5).max(1).default(0.7),
    DYNAMIC_LABEL_MIN_SOURCE_AGREEMENT: z.coerce.number().min(0.5).max(1).default(0.7),
    DYNAMIC_LABEL_MAX_CANDIDATES_PER_RUN: z.coerce.number().int().min(1).max(50).default(20),
    DYNAMIC_LABEL_MAX_MESSAGES_PER_RUN: z.coerce.number().int().min(1).max(5000).default(1000),
    DYNAMIC_LABEL_MAX_PENDING_CANDIDATES: z.coerce.number().int().min(1).max(500).default(50),
    DYNAMIC_LABEL_MAX_APPROVED_LABELS: z.coerce.number().int().min(1).max(500).default(100),
    DYNAMIC_LABEL_REDISCOVERY_DAYS: z.coerce.number().int().min(1).max(365).default(14),
    DYNAMIC_LABEL_AI_NAMING_ENABLED: booleanValue.default(false),
    AUTOMATION_ENABLED: booleanValue.default(true),
    AUTOMATION_SCHEDULE_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(2),
    AUTOMATION_POLL_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(60).default(15),
    AUTOMATION_LEASE_SECONDS: z.coerce.number().int().min(60).max(7200).default(1800),
    AUTOMATION_BATCH_SIZE: z.coerce.number().int().min(1).max(25).default(10),
    AUTOMATION_MAX_MESSAGES_PER_RUN: z.coerce.number().int().min(1).max(1000).default(250),
    AUTOMATION_MAX_LABELS: z.coerce.number().int().min(1).max(200).default(25),
    AUTOMATION_MAX_INPUT_TOKENS: z.coerce.number().int().min(1000).max(1000000).default(100000),
    AUTOMATION_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(100).max(100000).default(10000),
    AUTOMATION_MAX_COST_MICRO_USD: z.coerce
      .number()
      .int()
      .min(1000)
      .max(2000000000)
      .default(500000),
    AUTOMATION_CONFIDENCE_THRESHOLD: z.coerce.number().min(0.5).max(1).default(0.8),
    AUTOMATION_PATTERN_MIN_SAMPLES: z.coerce.number().int().min(1).max(100).default(2),
    AUTOMATION_PATTERN_MIN_CONFIDENCE: z.coerce.number().min(0.5).max(1).default(0.9),
    AUTOMATION_MAX_ACTION_RETRIES: z.coerce.number().int().min(1).max(10).default(3),
    GEMINI_API_KEY: optionalSecret,
    GEMINI_MODEL: z.string().min(1).max(200).default('gemini-2.5-flash-lite'),
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
    return { ...value, TOKEN_ENCRYPTION_KEY_BYTES: tokenEncryptionKey };
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
