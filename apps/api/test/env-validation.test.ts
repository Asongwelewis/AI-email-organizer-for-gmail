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

  it('defaults the taxonomy planner to a 500-message sample', async () => {
    const { env } = await loadWith({ TAXONOMY_SAMPLE_SIZE: undefined });
    expect(env.TAXONOMY_SAMPLE_SIZE).toBe(500);
  });

  it('rejects a taxonomy sample larger than one planning call can carry', async () => {
    await expect(loadWith({ TAXONOMY_SAMPLE_SIZE: '5000' })).rejects.toThrow();
  });

  it('refuses a session ceiling shorter than the idle window it caps', async () => {
    await expect(
      loadWith({ REFRESH_SESSION_TTL_DAYS: '30', SESSION_MAX_LIFETIME_DAYS: '14' }),
    ).rejects.toThrow();
  });

  it('migrates on boot in production only, unless told otherwise', async () => {
    expect((await loadWith({ MIGRATE_ON_START: undefined })).env.MIGRATE_ON_START).toBe(false);
    const production = await loadWith({
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      COOKIE_SAME_SITE: 'none',
      MIGRATE_ON_START: undefined,
    });
    expect(production.env.MIGRATE_ON_START).toBe(true);
    const optedOut = await loadWith({
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      COOKIE_SAME_SITE: 'none',
      MIGRATE_ON_START: 'false',
    });
    expect(optedOut.env.MIGRATE_ON_START).toBe(false);
  });

  it('runs the full job twice a day by default, at 02:00 and 14:00 UTC', async () => {
    const { env } = await loadWith({
      AUTOMATION_FULL_RUN_HOURS_UTC: undefined,
      AUTOMATION_SCHEDULE_HOUR_UTC: undefined,
    });
    expect(env.AUTOMATION_FULL_RUN_HOURS_UTC).toEqual([2, 14]);
  });

  it('reads a list of full-run hours, sorted and without repeats', async () => {
    const { env } = await loadWith({ AUTOMATION_FULL_RUN_HOURS_UTC: '18, 6,6' });
    expect(env.AUTOMATION_FULL_RUN_HOURS_UTC).toEqual([6, 18]);
  });

  // The old example file set this to 2; honouring a copied default would keep one run a day.
  it('ignores the retired single-hour setting rather than shrinking back to one run', async () => {
    const { env } = await loadWith({
      AUTOMATION_FULL_RUN_HOURS_UTC: undefined,
      AUTOMATION_SCHEDULE_HOUR_UTC: '2',
    });
    expect(env.AUTOMATION_FULL_RUN_HOURS_UTC).toEqual([2, 14]);
  });

  it('refuses an hour that is not on the clock', async () => {
    await expect(loadWith({ AUTOMATION_FULL_RUN_HOURS_UTC: '2,25' })).rejects.toThrow();
  });

  it('checks for new mail every minute by default, and refuses a hammering interval', async () => {
    expect((await loadWith({})).env.AUTOMATION_CHECK_INTERVAL_SECONDS).toBe(60);
    await expect(loadWith({ AUTOMATION_CHECK_INTERVAL_SECONDS: '5' })).rejects.toThrow();
    expect(
      (await loadWith({ AUTOMATION_CHECK_INTERVAL_SECONDS: '0' })).env
        .AUTOMATION_CHECK_INTERVAL_SECONDS,
    ).toBe(0);
  });

  it('takes both Web Push keys or neither', async () => {
    await expect(
      loadWith({ WEB_PUSH_VAPID_PUBLIC_KEY: 'public', WEB_PUSH_VAPID_PRIVATE_KEY: undefined }),
    ).rejects.toThrow();
    const { env } = await loadWith({
      WEB_PUSH_VAPID_PUBLIC_KEY: undefined,
      WEB_PUSH_VAPID_PRIVATE_KEY: undefined,
    });
    expect(env.WEB_PUSH_VAPID_PUBLIC_KEY).toBeUndefined();
  });

  it('accepts a mailto subject for push', async () => {
    const { env } = await loadWith({ WEB_PUSH_SUBJECT: 'mailto:push@example.com' });
    expect(env.WEB_PUSH_SUBJECT).toBe('mailto:push@example.com');
  });

  /*
   * The live Render service never received NODE_ENV, so everything gated on it stayed off:
   * migrations did not apply at boot and the favourites and notifications tables did not exist.
   * Render sets RENDER=true on every service, which is the signal that cannot be forgotten.
   */
  it('treats a Render service as a deployment even without NODE_ENV', async () => {
    const { env } = await loadWith({
      NODE_ENV: 'development',
      RENDER: 'true',
      MIGRATE_ON_START: undefined,
    });
    expect(env.IS_DEPLOYED).toBe(true);
    expect(env.MIGRATE_ON_START).toBe(true);
  });

  it('never treats a test run as a deployment, even on Render', async () => {
    const { env } = await loadWith({
      NODE_ENV: 'test',
      RENDER: 'true',
      MIGRATE_ON_START: undefined,
    });
    expect(env.IS_DEPLOYED).toBe(false);
    expect(env.MIGRATE_ON_START).toBe(false);
  });

  it('is not a deployment on a developer machine', async () => {
    const { env } = await loadWith({ NODE_ENV: 'development', RENDER: undefined });
    expect(env.IS_DEPLOYED).toBe(false);
  });

  it('accepts the cross-site cookie production deployments require', async () => {
    const { env } = await loadWith({
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      COOKIE_SAME_SITE: 'none',
    });
    expect(env.COOKIE_SAME_SITE).toBe('none');
  });

  it('accepts a same-site production cookie when a shared parent domain is configured', async () => {
    const { env } = await loadWith({
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      COOKIE_SAME_SITE: 'lax',
      COOKIE_DOMAIN: '.mailmindai.tech',
    });
    expect(env.COOKIE_SAME_SITE).toBe('lax');
  });

  it('builds session cookie options from COOKIE_SAME_SITE rather than hardcoding it', async () => {
    await loadWith({ COOKIE_SAME_SITE: 'strict' });
    const { sessionCookieOptions } = await import('../src/sessions/session.cookies.js');
    expect(sessionCookieOptions().sameSite).toBe('strict');
  });

  it('does not force a production cookie to none when a shared domain allows lax', async () => {
    await loadWith({
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      COOKIE_SAME_SITE: 'lax',
      COOKIE_DOMAIN: '.mailmindai.tech',
    });
    const { sessionCookieOptions } = await import('../src/sessions/session.cookies.js');
    expect(sessionCookieOptions().sameSite).toBe('lax');
  });

  it('honours COOKIE_SAME_SITE=none in production instead of assuming it', async () => {
    await loadWith({
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      COOKIE_SAME_SITE: 'none',
    });
    const { sessionCookieOptions } = await import('../src/sessions/session.cookies.js');
    const options = sessionCookieOptions();
    expect(options.sameSite).toBe('none');
    expect(options.secure).toBe(true);
  });

  it('defaults the Gemini model and pacing to the free-tier friendly values', async () => {
    const { env } = await loadWith({
      GEMINI_MODEL: undefined,
      GEMINI_MIN_REQUEST_INTERVAL_MS: undefined,
    });
    expect(env.GEMINI_MODEL).toBe('gemini-flash-lite-latest');
    // 15 requests per minute is the free-tier ceiling; 4000ms between calls sits exactly on it.
    expect(env.GEMINI_MIN_REQUEST_INTERVAL_MS).toBe(4000);
  });

  it('treats a missing Gemini key as absent rather than aborting startup', async () => {
    const { env } = await loadWith({ GEMINI_API_KEY: undefined });
    expect(env.GEMINI_API_KEY).toBeUndefined();
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
    [
      'a production cross-site cookie that would never reach the API',
      {
        NODE_ENV: 'production',
        COOKIE_SECURE: 'true',
        COOKIE_SAME_SITE: 'lax',
        COOKIE_DOMAIN: undefined,
      },
      'COOKIE_SAME_SITE',
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
