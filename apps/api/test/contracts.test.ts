import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { app } from '../src/app.js';
import { LOG_REDACTION_PATHS } from '../src/config/logger.js';
import {
  GMAIL_MODIFY_SCOPE,
  GOOGLE_GMAIL_SCOPES,
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
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('uses separate identity and Gmail scopes', () => {
    expect(GOOGLE_LOGIN_SCOPES).toEqual(['openid', 'email', 'profile']);
    expect(GOOGLE_LOGIN_SCOPES).not.toContain(GMAIL_MODIFY_SCOPE);
    expect(GOOGLE_GMAIL_SCOPES).toContain(GMAIL_MODIFY_SCOPE);
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
      ]),
    );
  });
});
