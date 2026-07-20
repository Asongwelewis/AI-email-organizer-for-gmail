import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  beginGoogleLogin: vi.fn(),
  completeGoogleLogin: vi.fn(),
  denyGoogleLogin: vi.fn(),
  me: vi.fn(),
  authenticate: vi.fn(),
  rotate: vi.fn(),
  revokeCurrent: vi.fn(),
  revokeAll: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('../src/auth/auth.service.js', () => ({
  authService: {
    beginGoogleLogin: mocks.beginGoogleLogin,
    completeGoogleLogin: mocks.completeGoogleLogin,
    denyGoogleLogin: mocks.denyGoogleLogin,
    me: mocks.me,
  },
}));
vi.mock('../src/sessions/session.service.js', () => ({
  sessionService: {
    authenticate: mocks.authenticate,
    rotate: mocks.rotate,
    revokeCurrent: mocks.revokeCurrent,
    revokeAll: mocks.revokeAll,
  },
}));
vi.mock('../src/audit/audit.service.js', () => ({ auditService: { record: mocks.audit } }));

import { authRouter } from '../src/auth/auth.routes.js';
import { AppError, authenticationRequired } from '../src/errors/AppError.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

const authenticated = {
  id: 'session-id',
  user: {
    id: 'authenticated-user-id',
    email: 'user@example.com',
    displayName: 'User',
    avatarUrl: null,
    status: 'ACTIVE' as const,
  },
};

const testApp = express();
testApp.use(express.json());
testApp.use(cookieParser());
testApp.use((request_, _response, next) => {
  request_.requestId = 'request-id';
  next();
});
testApp.use('/api/auth', authRouter);
testApp.use(errorHandler);

describe('authentication HTTP routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.beginGoogleLogin.mockResolvedValue('https://accounts.google.test/authorize');
    mocks.completeGoogleLogin.mockResolvedValue({
      rawToken: 'raw-session-token',
      session: authenticated,
      redirectPath: '/dashboard',
    });
    mocks.denyGoogleLogin.mockResolvedValue('/auth/callback');
    mocks.me.mockResolvedValue({ user: { ...authenticated.user, gmailConnected: false } });
    mocks.authenticate.mockImplementation(async (request_) => {
      const cookies = request_.cookies as Record<string, string>;
      if (cookies['mailmind_session'] !== 'valid-session') throw authenticationRequired();
      return authenticated;
    });
    mocks.rotate.mockResolvedValue({ rawToken: 'rotated-session-token', session: authenticated });
    mocks.revokeCurrent.mockResolvedValue(null);
    mocks.revokeAll.mockResolvedValue({ count: 2 });
    mocks.audit.mockResolvedValue(undefined);
  });

  it('redirects login start and callback without placing tokens in URLs or JSON', async () => {
    const start = await request(testApp).get('/api/auth/google');
    expect(start.status).toBe(302);
    expect(start.headers['location']).toBe('https://accounts.google.test/authorize');

    const callback = await request(testApp).get(
      '/api/auth/google/callback?code=authorization-code&state=oauth-state',
    );
    expect(callback.status).toBe(302);
    expect(callback.headers['location']).toContain('status=login_succeeded');
    expect(callback.headers['location']).not.toContain('raw-session-token');
    expect(callback.headers['location']).not.toContain('authorization-code');
    expect(callback.headers['set-cookie']?.[0]).toContain('mailmind_session=raw-session-token');
    expect(callback.headers['set-cookie']?.[0]).toContain('HttpOnly');
  });

  it('handles Google denial with a safe redirect and consumes the supplied state', async () => {
    const response = await request(testApp).get(
      '/api/auth/google/callback?error=access_denied&error_description=sensitive&state=denied-state',
    );
    expect(response.status).toBe(302);
    expect(response.headers['location']).toContain('status=login_failed');
    expect(response.headers['location']).toContain('/auth/callback');
    expect(response.headers['location']).not.toContain('sensitive');
    expect(mocks.denyGoogleLogin).toHaveBeenCalledWith(expect.anything(), 'denied-state');
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('requires the cookie for current-user access and ignores frontend user IDs', async () => {
    const missing = await request(testApp)
      .get('/api/auth/me?userId=attacker')
      .send({ userId: 'attacker' });
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('AUTHENTICATION_REQUIRED');

    const valid = await request(testApp)
      .get('/api/auth/me?userId=attacker')
      .set('Cookie', 'mailmind_session=valid-session');
    expect(valid.status).toBe(200);
    expect(mocks.me).toHaveBeenCalledWith('authenticated-user-id', authenticated.user);
    expect(valid.body.user.id).toBe('authenticated-user-id');
  });

  it('rotates refresh sessions and never returns the replacement token in JSON', async () => {
    const response = await request(testApp)
      .post('/api/auth/refresh')
      .set('Cookie', 'mailmind_session=valid-session');
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain('rotated-session-token');
    expect(response.headers['set-cookie']?.[0]).toContain('mailmind_session=rotated-session-token');

    mocks.rotate.mockRejectedValueOnce(
      new AppError('AUTH_SESSION_EXPIRED', 'Your session has expired.', 401),
    );
    const expired = await request(testApp).post('/api/auth/refresh');
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('AUTH_SESSION_EXPIRED');
  });

  it('supports idempotent current logout and authenticated logout-all', async () => {
    const logout = await request(testApp).post('/api/auth/logout');
    expect(logout.status).toBe(200);
    expect(logout.body).toEqual({ success: true });
    expect(logout.headers['set-cookie']?.[0]).toContain('mailmind_session=;');

    const unauthorized = await request(testApp).post('/api/auth/logout-all');
    expect(unauthorized.status).toBe(401);
    const all = await request(testApp)
      .post('/api/auth/logout-all')
      .set('Cookie', 'mailmind_session=valid-session');
    expect(all.status).toBe(200);
    expect(all.body).toEqual({ success: true, revokedSessions: 2 });
    expect(mocks.revokeAll).toHaveBeenCalledWith('authenticated-user-id');
  });
});
