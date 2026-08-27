import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  submit: vi.fn(),
}));

vi.mock('../src/sessions/session.service.js', () => ({
  sessionService: { authenticate: mocks.authenticate },
}));
vi.mock('../src/features/feedback/feedback.service.js', () => ({
  feedbackService: { submit: mocks.submit },
}));

import { authenticationRequired } from '../src/errors/AppError.js';

const ORIGIN = 'http://localhost:5173';

/**
 * Rebuilt per test, through a cleared module registry.
 *
 * The limiter is module state and its budget is five — deliberately small, and smaller than the
 * number of cases in this file, so a shared instance would start answering 429 partway through and
 * every later assertion would be measuring the limiter instead of the route. `resetAll` is not on
 * the handler in express-rate-limit 8, and resetting by key would mean hard-coding whatever the
 * library currently makes of a loopback address. A fresh module graph needs to know neither.
 */
async function buildApp() {
  vi.resetModules();
  const { feedbackRouter } = await import('../src/features/feedback/feedback.routes.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((request_, _response, next) => {
    request_.requestId = 'request-id';
    next();
  });
  app.use('/api/feedback', feedbackRouter);
  app.use(errorHandler);
  return app;
}
const NOTE = 'The Sorted screen shows GMAIL_REAUTH_REQUIRED and reconnecting does not clear it.';

/**
 * The only unauthenticated write in the API, which is the whole reason it needs its own suite:
 * every other route can lean on `requireSession` to keep strangers out, and this one deliberately
 * cannot.
 */
describe('feedback HTTP route', () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.resetAllMocks();
    // The ordinary case: somebody who was handed the link and has never signed in.
    mocks.authenticate.mockRejectedValue(authenticationRequired());
    mocks.submit.mockResolvedValue(undefined);
    app = await buildApp();
  });

  it('accepts a note from someone with no session at all', async () => {
    const response = await request(app)
      .post('/api/feedback')
      .set('Origin', ORIGIN)
      .send({ kind: 'PROBLEM', message: NOTE });

    expect(response.status).toBe(201);
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'PROBLEM', message: NOTE, userId: undefined }),
    );
  });

  /**
   * A failed `authenticate` is the normal path here, not an error path. If the rejection ever
   * escapes the controller the endpoint becomes authenticated by accident, and the feature — a way
   * for a stranger to report that sign-in is broken — stops working in exactly the case it exists
   * for.
   */
  it('does not turn a rejected session into a 401', async () => {
    mocks.authenticate.mockRejectedValue(new Error('token store unreachable'));

    const response = await request(app)
      .post('/api/feedback')
      .set('Origin', ORIGIN)
      .send({ kind: 'OTHER', message: NOTE });

    expect(response.status).toBe(201);
  });

  it('attributes the note when a session happens to be present', async () => {
    mocks.authenticate.mockResolvedValue({
      id: 'session-id',
      user: { id: 'user-id', email: 'user@example.com', status: 'ACTIVE' },
    });

    await request(app)
      .post('/api/feedback')
      .set('Origin', ORIGIN)
      .send({ kind: 'IDEA', message: NOTE })
      .expect(201);

    expect(mocks.submit).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-id' }));
  });

  it('rejects a note too short to act on', async () => {
    const response = await request(app)
      .post('/api/feedback')
      .set('Origin', ORIGIN)
      .send({ kind: 'PROBLEM', message: 'broken' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('FEEDBACK_VALIDATION_FAILED');
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('rejects a kind outside the four the table knows', async () => {
    await request(app)
      .post('/api/feedback')
      .set('Origin', ORIGIN)
      .send({ kind: 'URGENT', message: NOTE })
      .expect(400);

    expect(mocks.submit).not.toHaveBeenCalled();
  });

  /**
   * `.strict()` earns its place here more than anywhere else in the API: this is the one body a
   * stranger composes, and an unknown key reaching a Prisma `create` is how a column nobody
   * intended to expose gets written.
   */
  it('rejects a body carrying keys the form does not have', async () => {
    await request(app)
      .post('/api/feedback')
      .set('Origin', ORIGIN)
      .send({ kind: 'PRAISE', message: NOTE, user_id: 'someone-else' })
      .expect(400);

    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('treats a blank contact as declining a reply rather than as a bad address', async () => {
    await request(app)
      .post('/api/feedback')
      .set('Origin', ORIGIN)
      .send({ kind: 'IDEA', message: NOTE, contact: '' })
      .expect(201);

    expect(mocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({ contact: undefined, message: NOTE }),
    );
  });

  it('refuses an address that could never be written to', async () => {
    await request(app)
      .post('/api/feedback')
      .set('Origin', ORIGIN)
      .send({ kind: 'IDEA', message: NOTE, contact: 'not-an-address' })
      .expect(400);
  });

  /**
   * Our routes carry facet values, search phrases and message ids in the query string. `page` is a
   * debugging convenience, and no convenience is worth storing somebody's search.
   */
  it('stores a route but never a query string', async () => {
    await request(app)
      .post('/api/feedback')
      .set('Origin', ORIGIN)
      .send({ kind: 'PROBLEM', message: NOTE, page: '/sorted' })
      .expect(201);
    expect(mocks.submit).toHaveBeenCalledWith(expect.objectContaining({ page: '/sorted' }));

    mocks.submit.mockClear();
    await request(app)
      .post('/api/feedback')
      .set('Origin', ORIGIN)
      .send({ kind: 'PROBLEM', message: NOTE, page: '/find?q=my+bank+statement' })
      .expect(400);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  // Unauthenticated does not mean unguarded: a page on another origin must not be able to post
  // through somebody's browser.
  it('refuses a submission from an untrusted origin', async () => {
    const response = await request(app)
      .post('/api/feedback')
      .set('Origin', 'https://not-mailmind.example')
      .send({ kind: 'PRAISE', message: NOTE });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CSRF_ORIGIN_INVALID');
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  /**
   * Five per window, and shared across API instances. This is the only route a stranger can write
   * to, so the counter being per-instance would mean the cost of getting past it was a retry until
   * the load balancer picked a different process.
   */
  it('stops a client filling the table', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app)
        .post('/api/feedback')
        .set('Origin', ORIGIN)
        .send({ kind: 'OTHER', message: NOTE })
        .expect(201);
    }

    const refused = await request(app)
      .post('/api/feedback')
      .set('Origin', ORIGIN)
      .send({ kind: 'OTHER', message: NOTE });

    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(mocks.submit).toHaveBeenCalledTimes(5);
  });
});
