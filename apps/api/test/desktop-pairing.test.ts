import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  updateMany: vi.fn(),
  findFirst: vi.fn(),
  authenticate: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock('../src/database/prisma.js', () => ({
  prisma: {
    desktop_pairings: {
      create: mocks.create,
      updateMany: mocks.updateMany,
      findFirst: mocks.findFirst,
    },
  },
}));
vi.mock('../src/sessions/session.service.js', () => ({
  sessionService: {
    authenticate: mocks.authenticate,
    authenticateAndRenew: async (request_: unknown) => ({
      session: await mocks.authenticate(request_),
      renewedToken: null,
    }),
    create: mocks.createSession,
  },
}));

import { authenticationRequired } from '../src/errors/AppError.js';
import { sha256 } from '../src/security/hashing.service.js';
import {
  desktopPairingService,
  normalizeUserCode,
  PAIRING_TTL_MS,
} from '../src/features/desktop/desktop-pairing.service.js';

const ORIGIN = 'http://localhost:5173';
const NOW = new Date('2026-11-17T12:00:00.000Z');
const PAIRING_ID = '00000000-0000-4000-8000-000000000001';
const SECRET = 'x'.repeat(43);

const owner = {
  id: 'session-1',
  expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
  user: { id: 'user-1', email: 'owner@example.com', status: 'ACTIVE' },
};

/** A fresh module graph per test, so the small rate-limit budgets never leak between cases. */
async function buildApp() {
  vi.resetModules();
  const { desktopRouter } = await import('../src/features/desktop/desktop-pairing.routes.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  // Signed out by default, with the error class of this module graph, which is the one the
  // error handler recognises.
  const fresh = await import('../src/errors/AppError.js');
  mocks.authenticate.mockRejectedValue(fresh.authenticationRequired());
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((request_, _response, next) => {
    request_.requestId = 'request-id';
    next();
  });
  app.use('/api/desktop', desktopRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticate.mockRejectedValue(authenticationRequired());
});

/*
 * Google refuses sign-in inside a desktop program, so the island pairs like a television: it shows
 * a code, the person types it into AMO where they are signed in, and the island's next poll gets a
 * session of its own.
 */
describe('desktop pairing', () => {
  it('stores only hashes, and hands the island its code and secret once', async () => {
    mocks.create.mockImplementation(async ({ data }) => ({ id: PAIRING_ID, ...data }));

    const started = await desktopPairingService.start(NOW);

    expect(started.userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    const stored = mocks.create.mock.calls[0]![0].data;
    expect(stored.poll_secret_hash).toBe(sha256(started.pollSecret));
    expect(stored.user_code_hash).toBe(sha256(normalizeUserCode(started.userCode)));
    expect(JSON.stringify(stored)).not.toContain(started.pollSecret);
    expect(stored.expires_at).toEqual(new Date(NOW.getTime() + PAIRING_TTL_MS));
  });

  it('accepts the code however it is typed, and only while it is waiting', async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });

    await desktopPairingService.approve('user-1', ' bcdf-ghjk ', NOW);

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { user_code_hash: sha256('BCDFGHJK'), approved_at: null, expires_at: { gt: NOW } },
      data: { approved_user_id: 'user-1', approved_at: NOW },
    });
  });

  it('says so when no island is waiting for a code', async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });
    await expect(desktopPairingService.approve('user-1', 'BCDF-GHJK', NOW)).rejects.toMatchObject({
      code: 'DESKTOP_CODE_NOT_FOUND',
      statusCode: 404,
    });
    await expect(desktopPairingService.approve('user-1', 'BCD', NOW)).rejects.toMatchObject({
      code: 'DESKTOP_CODE_INVALID',
    });
  });

  it('keeps the island waiting, then connects it exactly once', async () => {
    const waiting = {
      id: PAIRING_ID,
      approved_user_id: null,
      completed_at: null,
      expires_at: new Date(NOW.getTime() + 60_000),
    };
    mocks.findFirst.mockResolvedValueOnce(waiting);
    expect(await desktopPairingService.complete(PAIRING_ID, SECRET, NOW)).toEqual({
      status: 'pending',
    });
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { id: PAIRING_ID, poll_secret_hash: sha256(SECRET) },
    });

    mocks.findFirst.mockResolvedValueOnce({ ...waiting, approved_user_id: 'user-1' });
    mocks.updateMany.mockResolvedValueOnce({ count: 1 });
    expect(await desktopPairingService.complete(PAIRING_ID, SECRET, NOW)).toEqual({
      status: 'connected',
      userId: 'user-1',
    });

    // A second poll that raced the first finds it already claimed.
    mocks.findFirst.mockResolvedValueOnce({ ...waiting, approved_user_id: 'user-1' });
    mocks.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await desktopPairingService.complete(PAIRING_ID, SECRET, NOW)).toEqual({
      status: 'expired',
    });
  });

  it('treats an unknown secret, a used pairing and a lapsed one alike', async () => {
    mocks.findFirst.mockResolvedValueOnce(null);
    expect(await desktopPairingService.complete(PAIRING_ID, SECRET, NOW)).toEqual({
      status: 'expired',
    });
    mocks.findFirst.mockResolvedValueOnce({
      id: PAIRING_ID,
      approved_user_id: null,
      completed_at: null,
      expires_at: new Date(NOW.getTime() - 1),
    });
    expect(await desktopPairingService.complete(PAIRING_ID, SECRET, NOW)).toEqual({
      status: 'expired',
    });
  });
});

describe('desktop pairing routes', () => {
  it('gives the island a session cookie once its code was typed, and not before', async () => {
    const app = await buildApp();
    mocks.findFirst.mockResolvedValueOnce({
      id: PAIRING_ID,
      approved_user_id: null,
      completed_at: null,
      expires_at: new Date(Date.now() + 60_000),
    });
    const pending = await request(app)
      .post('/api/desktop/pairings/complete')
      .set('Origin', ORIGIN)
      .send({ pairingId: PAIRING_ID, pollSecret: SECRET });
    expect(pending.status).toBe(202);
    expect(pending.headers['set-cookie']).toBeUndefined();

    mocks.findFirst.mockResolvedValueOnce({
      id: PAIRING_ID,
      approved_user_id: 'user-1',
      completed_at: null,
      expires_at: new Date(Date.now() + 60_000),
    });
    mocks.updateMany.mockResolvedValueOnce({ count: 1 });
    mocks.createSession.mockResolvedValueOnce({ rawToken: 'raw-token', session: owner });
    const connected = await request(app)
      .post('/api/desktop/pairings/complete')
      .set('Origin', ORIGIN)
      .send({ pairingId: PAIRING_ID, pollSecret: SECRET });

    expect(connected.status).toBe(200);
    expect(connected.body).toEqual({ status: 'connected' });
    expect(String(connected.headers['set-cookie'])).toContain('mailmind_session=raw-token');
    expect(String(connected.headers['set-cookie'])).toContain('HttpOnly');
  });

  it('refuses to approve without a session, or from another site', async () => {
    const app = await buildApp();
    const signedOut = await request(app)
      .post('/api/desktop/pairings/approve')
      .set('Origin', ORIGIN)
      .send({ code: 'BCDF-GHJK' });
    expect(signedOut.status).toBe(401);

    mocks.authenticate.mockResolvedValue(owner);
    const elsewhere = await request(app)
      .post('/api/desktop/pairings/approve')
      .set('Origin', 'https://evil.example')
      .send({ code: 'BCDF-GHJK' });
    expect(elsewhere.status).toBe(403);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('approves for the signed-in person', async () => {
    const app = await buildApp();
    mocks.authenticate.mockResolvedValue(owner);
    mocks.updateMany.mockResolvedValueOnce({ count: 1 });

    const approved = await request(app)
      .post('/api/desktop/pairings/approve')
      .set('Origin', ORIGIN)
      .send({ code: 'bcdf ghjk' });

    expect(approved.status).toBe(200);
    expect(mocks.updateMany.mock.calls[0]![0].data.approved_user_id).toBe('user-1');
  });
});
