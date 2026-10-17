import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ authenticateAndRenew: vi.fn() }));

vi.mock('../src/sessions/session.service.js', () => ({
  sessionService: { authenticateAndRenew: mocks.authenticateAndRenew },
}));

import { errorHandler } from '../src/middleware/errorHandler.js';
import { requireSession } from '../src/sessions/session.middleware.js';
import { authenticationRequired } from '../src/errors/AppError.js';

const session = {
  id: 'session-id',
  user: {
    id: 'user-id',
    email: 'user@example.com',
    displayName: null,
    avatarUrl: null,
    status: 'ACTIVE' as const,
    tutorialCompletedAt: null,
  },
  expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
};

const app = express();
app.use(cookieParser());
app.get('/protected', requireSession, (request_, response) => {
  response.json({ userId: request_.auth?.user.id });
});
app.use(errorHandler);

/**
 * The browser keeps its own copy of the session's lifetime, in the cookie. Extending the row
 * without re-issuing the cookie would leave that copy expiring first, and the person would be
 * logged out on the old date anyway.
 */
describe('requireSession', () => {
  beforeEach(() => vi.resetAllMocks());

  it('re-issues the same token with the new lifetime when the session was extended', async () => {
    mocks.authenticateAndRenew.mockResolvedValue({ session, renewedToken: 'raw-session-token' });

    const response = await request(app)
      .get('/protected')
      .set('Cookie', 'mailmind_session=raw-session-token');

    expect(response.status).toBe(200);
    expect(response.body.userId).toBe('user-id');
    const cookie = response.headers['set-cookie']?.[0] ?? '';
    expect(cookie).toContain('mailmind_session=raw-session-token');
    expect(cookie).toContain('HttpOnly');
    const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)?.[1]);
    expect(maxAge).toBeGreaterThan(29 * 24 * 60 * 60);
  });

  it('sets no cookie when nothing was extended', async () => {
    mocks.authenticateAndRenew.mockResolvedValue({ session, renewedToken: null });

    const response = await request(app)
      .get('/protected')
      .set('Cookie', 'mailmind_session=raw-session-token');

    expect(response.status).toBe(200);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('passes an invalid session through as a 401', async () => {
    mocks.authenticateAndRenew.mockRejectedValue(authenticationRequired());

    const response = await request(app).get('/protected');

    expect(response.status).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
  });
});
