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

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
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
    GMAIL_INITIAL_SYNC_MAX_MESSAGES: z.coerce.number().int().min(1).max(5000).default(250),
    GMAIL_SYNC_PAGE_SIZE: z.coerce.number().int().min(1).max(500).default(100),
    GMAIL_SYNC_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(10),
    GMAIL_SYNC_MAX_RETRIES: z.coerce.number().int().min(0).max(8).default(3),
    GMAIL_SYNC_RETRY_BASE_MS: z.coerce.number().int().min(10).max(30_000).default(250),
    GMAIL_SYNC_LEASE_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    AI_CLASSIFIER_ENABLED: booleanValue.default(false),
    AI_CLASSIFIER_PROVIDER: z.enum(['disabled', 'mock', 'external']).default('disabled'),
    AI_CLASSIFIER_MODEL: z.string().min(1).max(200).default('not-configured'),
    AI_CLASSIFIER_API_KEY: optionalSecret,
    AI_CLASSIFIER_BASE_URL: z.string().url().optional(),
    AI_CLASSIFIER_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(15_000),
    AI_CLASSIFIER_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
    AI_CLASSIFIER_BATCH_SIZE: z.coerce.number().int().min(1).max(25).default(5),
    AI_CLASSIFIER_OUTPUT_MAX_TOKENS: z.coerce.number().int().min(64).max(2048).default(400),
    AI_CLASSIFICATION_MAX_MESSAGES_PER_RUN: z.coerce.number().int().min(1).max(250).default(20),
    AI_CLASSIFICATION_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.7),
    AI_CLASSIFICATION_REVIEW_THRESHOLD: z.coerce.number().min(0).max(1).default(0.65),
    AI_CLASSIFICATION_INPUT_MAX_CHARS: z.coerce.number().int().min(500).max(20_000).default(4000),
    AI_CLASSIFICATION_RULE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.9),
    AI_CLASSIFICATION_LEASE_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
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
    if (
      value.AI_CLASSIFIER_ENABLED &&
      value.AI_CLASSIFIER_PROVIDER === 'external' &&
      (!value.AI_CLASSIFIER_API_KEY || !value.AI_CLASSIFIER_BASE_URL)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['AI_CLASSIFIER_API_KEY'],
        message: 'and AI_CLASSIFIER_BASE_URL are required for the external provider',
      });
      return z.NEVER;
    }
    return { ...value, TOKEN_ENCRYPTION_KEY_BYTES: tokenEncryptionKey };
  });

const testDefaults = isTest
  ? {
      WEB_APP_URL: 'http://localhost:5173',
      API_BASE_URL: 'http://localhost:4000',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      GOOGLE_CLIENT_ID: 'test-google-client-id',
      GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
      GOOGLE_LOGIN_REDIRECT_URI: 'http://localhost:4000/api/auth/google/callback',
      GOOGLE_GMAIL_REDIRECT_URI: 'http://localhost:4000/api/integrations/google/callback',
      SESSION_SECRET: 'test-session-secret-long-enough',
      TOKEN_ENCRYPTION_KEY: testKey,
      TOKEN_ENCRYPTION_KEY_VERSION: '1',
      COOKIE_SECURE: 'false',
    }
  : {};

const candidate = {
  ...testDefaults,
  ...process.env,
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
