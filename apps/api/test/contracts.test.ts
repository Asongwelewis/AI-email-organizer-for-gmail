import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { LOG_REDACTION_PATHS } from '../src/config/logger.js';
import {
  GMAIL_MODIFY_SCOPE,
  GMAIL_READONLY_SCOPE,
  googleGmailScopes,
  hasGmailReadScope,
  hasGmailWriteScope,
  holdsUnusedWriteScope,
  requestedGmailScope,
  GOOGLE_LOGIN_SCOPES,
} from '../src/integrations/google/google-scopes.js';
import {
  clearSessionCookie,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from '../src/sessions/session.cookies.js';

describe('API security contracts', () => {
  it('preserves the health endpoint', async () => {
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    const unprefixed = await request(app).get('/health');
    expect(unprefixed.status).toBe(200);
    expect(unprefixed.body.status).toBe('ok');
  });

  it('returns the safe error shape and ignores frontend user IDs without a session', async () => {
    const response = await request(app).get('/api/auth/me?userId=attacker-controlled');
    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: 'AUTHENTICATION_REQUIRED', message: 'You need to sign in to continue.' },
    });
    expect(response.body).not.toHaveProperty('stack');
    expect(response.body.error).not.toHaveProperty('stack');
  });

  it('allows credentialed CORS only for the configured frontend', async () => {
    const allowed = await request(app).get('/api/health').set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    const denied = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(denied.status).toBe(403);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('uses separate identity and Gmail scopes', () => {
    expect(GOOGLE_LOGIN_SCOPES).toEqual(['openid', 'email', 'profile']);
    expect(GOOGLE_LOGIN_SCOPES).not.toContain(GMAIL_MODIFY_SCOPE);
    expect(GOOGLE_LOGIN_SCOPES).not.toContain(GMAIL_READONLY_SCOPE);
    expect(googleGmailScopes()).toContain(requestedGmailScope());
  });

  /**
   * Card 25. `gmail.modify` is a Google restricted scope — it can alter and delete a person's
   * mail, which is what pulls an app into verification plus an annual CASA Tier 2 assessment.
   * With Gmail out of the write path the product does not use it, and the default connection must
   * not ask for it.
   */
  it('asks for read-only Gmail access unless the label export is turned on', () => {
    env.GMAIL_WRITE_ENABLED = false;
    expect(requestedGmailScope()).toBe(GMAIL_READONLY_SCOPE);
    expect(googleGmailScopes()).not.toContain(GMAIL_MODIFY_SCOPE);

    env.GMAIL_WRITE_ENABLED = true;
    expect(requestedGmailScope()).toBe(GMAIL_MODIFY_SCOPE);

    env.GMAIL_WRITE_ENABLED = false;
  });

  // `modify` implies read, so a grant made before the downgrade is still a working connection —
  // but it is wider than this deployment uses, which is worth offering to narrow.
  it('treats a legacy modify grant as readable, writable, and wider than needed', () => {
    env.GMAIL_WRITE_ENABLED = false;
    expect(hasGmailReadScope([GMAIL_MODIFY_SCOPE])).toBe(true);
    expect(hasGmailWriteScope([GMAIL_MODIFY_SCOPE])).toBe(true);
    expect(holdsUnusedWriteScope([GMAIL_MODIFY_SCOPE])).toBe(true);

    expect(hasGmailReadScope([GMAIL_READONLY_SCOPE])).toBe(true);
    expect(hasGmailWriteScope([GMAIL_READONLY_SCOPE])).toBe(false);
    expect(holdsUnusedWriteScope([GMAIL_READONLY_SCOPE])).toBe(false);
  });

  it('configures an opaque HttpOnly session cookie', () => {
    const options = sessionCookieOptions();
    expect(SESSION_COOKIE_NAME).toBe('mailmind_session');
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
    expect(options.path).toBe('/');
    expect(options.maxAge).toBeGreaterThan(0);
  });

  it('clears the cookie using matching security attributes', () => {
    const response = { clearCookie: vi.fn() } as never;
    clearSessionCookie(response);
    const clearOptions = (response as { clearCookie: ReturnType<typeof vi.fn> }).clearCookie.mock
      .calls[0]?.[1];
    const { maxAge: _maxAge, ...setOptions } = sessionCookieOptions();
    expect(clearOptions).toEqual(setOptions);
  });

  it('redacts authentication material from logs', () => {
    expect(LOG_REDACTION_PATHS).toEqual(
      expect.arrayContaining([
        'req.headers.cookie',
        'res.headers.set-cookie',
        'code',
        'state',
        'access_token',
        'refresh_token',
        'id_token',
        'client_secret',
        'session_token',
        'DATABASE_URL',
        'TOKEN_ENCRYPTION_KEY',
      ]),
    );
  });
});
