import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnvironment = { ...process.env };

const validEnvironment = {
  NODE_ENV: 'development',
  PORT: '4000',
  WEB_APP_URL: 'http://localhost:5173',
  API_BASE_URL: 'http://localhost:4000',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_LOGIN_REDIRECT_URI: 'http://localhost:4000/api/auth/google/callback',
  GOOGLE_GMAIL_REDIRECT_URI: 'http://localhost:4000/api/integrations/google/callback',
  SESSION_SECRET: 'test-session-secret-long-enough',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'),
  TOKEN_ENCRYPTION_KEY_VERSION: '1',
  COOKIE_SECURE: 'false',
  COOKIE_SAME_SITE: 'lax',
  ACCESS_SESSION_TTL_MINUTES: '15',
  REFRESH_SESSION_TTL_DAYS: '14',
  OAUTH_STATE_TTL_MINUTES: '10',
  AUTH_RATE_LIMIT_WINDOW_MINUTES: '10',
  AUTH_RATE_LIMIT_MAX_REQUESTS: '30',
  LOG_LEVEL: 'silent',
};

async function loadWith(overrides: Record<string, string | undefined>) {
  process.env = { ...originalEnvironment, ...validEnvironment, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
  }
  vi.resetModules();
  return import('../src/config/env.js');
}

afterEach(() => {
  process.env = { ...originalEnvironment };
  vi.resetModules();
});

describe('environment validation', () => {
  it('accepts a decoded 32-byte encryption key and positive version', async () => {
    const { env } = await loadWith({});
    expect(env.TOKEN_ENCRYPTION_KEY_BYTES).toHaveLength(32);
    expect(env.TOKEN_ENCRYPTION_KEY_VERSION).toBe(1);
  });

  it('enables dynamic label discovery when no explicit override is configured', async () => {
    const { env } = await loadWith({ DYNAMIC_LABEL_DISCOVERY_ENABLED: undefined });
    expect(env.DYNAMIC_LABEL_DISCOVERY_ENABLED).toBe(true);
  });

  it('accepts optional Sentry runtime configuration and a shared release', async () => {
    const { env } = await loadWith({
      APP_VERSION: 'mailmind@test-release',
      SENTRY_DSN: 'https://public@example.ingest.sentry.io/1',
      SENTRY_ENVIRONMENT: 'staging',
      SENTRY_TRACES_SAMPLE_RATE: '0.25',
      SENTRY_DEBUG: 'true',
    });

    expect(env.APP_VERSION).toBe('mailmind@test-release');
    expect(env.SENTRY_DSN).toBe('https://public@example.ingest.sentry.io/1');
    expect(env.SENTRY_ENVIRONMENT).toBe('staging');
    expect(env.SENTRY_TRACES_SAMPLE_RATE).toBe(0.25);
    expect(env.SENTRY_DEBUG).toBe(true);
  });

  it.each([
    [
      'invalid key length',
      { TOKEN_ENCRYPTION_KEY: Buffer.alloc(31).toString('base64') },
      'TOKEN_ENCRYPTION_KEY',
    ],
    ['invalid key version', { TOKEN_ENCRYPTION_KEY_VERSION: '0' }, 'TOKEN_ENCRYPTION_KEY_VERSION'],
    [
      'insecure production cookie',
      { NODE_ENV: 'production', COOKIE_SECURE: 'false' },
      'COOKIE_SECURE',
    ],
    ['empty Google client ID', { GOOGLE_CLIENT_ID: '' }, 'GOOGLE_CLIENT_ID'],
    [
      'invalid redirect URI',
      { GOOGLE_LOGIN_REDIRECT_URI: 'not-a-url' },
      'GOOGLE_LOGIN_REDIRECT_URI',
    ],
    ['invalid Sentry DSN', { SENTRY_DSN: 'not-a-url' }, 'SENTRY_DSN'],
    [
      'invalid Sentry trace rate',
      { SENTRY_TRACES_SAMPLE_RATE: '1.1' },
      'SENTRY_TRACES_SAMPLE_RATE',
    ],
  ])('rejects %s without exposing values', async (_description, overrides, expectedField) => {
    await expect(loadWith(overrides)).rejects.toThrow(expectedField);
    try {
      await loadWith(overrides);
    } catch (error) {
      expect(String(error)).not.toContain('test-client-secret');
      expect(String(error)).not.toContain(validEnvironment.TOKEN_ENCRYPTION_KEY);
    }
  });
});
