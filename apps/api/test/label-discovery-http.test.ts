import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  status: vi.fn(),
  candidates: vi.fn(),
  candidate: vi.fn(),
  run: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  defer: vi.fn(),
  merge: vi.fn(),
}));

vi.mock('../src/sessions/session.service.js', () => ({
  sessionService: { authenticate: mocks.authenticate },
}));
vi.mock('../src/features/label-discovery/label-discovery.service.js', () => ({
  labelDiscoveryService: mocks,
}));

import { AppError } from '../src/errors/AppError.js';
import { labelDiscoveryRouter } from '../src/features/label-discovery/label-discovery.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

const testApp = express();
testApp.use(express.json());
testApp.use(cookieParser());
testApp.use((request_, _response, next) => {
  request_.requestId = 'request-id';
  next();
});
testApp.use('/api/label-discovery', labelDiscoveryRouter);
testApp.use(errorHandler);

const candidateId = '00000000-0000-4000-8000-000000000001';
const targetId = '00000000-0000-4000-8000-000000000002';

describe('label discovery HTTP routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.authenticate.mockResolvedValue({
      id: 'session-id',
      user: { id: 'user-id', email: 'user@example.com', status: 'ACTIVE' },
    });
    mocks.status.mockResolvedValue({ enabled: true, running: false, pendingCount: 1 });
    mocks.candidates.mockResolvedValue({ candidates: [], nextCursor: null });
    mocks.run.mockResolvedValue({ success: true, runId: candidateId });
    mocks.approve.mockResolvedValue({ status: 'APPROVED', gmailLabelCreated: false });
    mocks.reject.mockResolvedValue({ status: 'REJECTED' });
    mocks.defer.mockResolvedValue({ status: 'DEFERRED' });
    mocks.merge.mockResolvedValue({ status: 'MERGED' });
  });

  it('requires authentication and excludes sensitive status fields', async () => {
    mocks.authenticate.mockRejectedValueOnce(
      new AppError('AUTHENTICATION_REQUIRED', 'Sign in.', 401),
    );
    expect((await request(testApp).get('/api/label-discovery/status')).status).toBe(401);
    const safe = await request(testApp).get('/api/label-discovery/status');
    expect(JSON.stringify(safe.body)).not.toMatch(/accessToken|refreshToken|apiKey|rawPrompt/i);
  });

  it('validates bounded discovery preferences', async () => {
    const invalid = await request(testApp)
      .post('/api/label-discovery/run')
      .set('Origin', 'http://localhost:5173')
      .send({ minMessages: 2, maxCandidates: 500 });
    expect(invalid.status).toBe(400);
    expect(mocks.run).not.toHaveBeenCalled();

    const valid = await request(testApp)
      .post('/api/label-discovery/run')
      .set('Origin', 'http://localhost:5173')
      .send({ minMessages: 3, allowedCandidateTypes: ['SOURCE', 'TOPIC'] });
    expect(valid.status).toBe(200);
    expect(mocks.run).toHaveBeenCalledWith('user-id', expect.objectContaining({ minMessages: 3 }));
  });

  it('rejects cross-origin mutations', async () => {
    const response = await request(testApp)
      .post(`/api/label-discovery/candidates/${candidateId}/approve`)
      .set('Origin', 'https://evil.example')
      .send({});
    expect(response.status).toBe(403);
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it('supports approval, rejection, defer, and merge decisions', async () => {
    const origin = 'http://localhost:5173';
    expect(
      (
        await request(testApp)
          .post(`/api/label-discovery/candidates/${candidateId}/approve`)
          .set('Origin', origin)
          .send({ leafName: 'GitHub Activity' })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(testApp)
          .post(`/api/label-discovery/candidates/${candidateId}/reject`)
          .set('Origin', origin)
          .send({})
      ).status,
    ).toBe(201);
    expect(
      (
        await request(testApp)
          .post(`/api/label-discovery/candidates/${candidateId}/defer`)
          .set('Origin', origin)
          .send({})
      ).status,
    ).toBe(201);
    expect(
      (
        await request(testApp)
          .post(`/api/label-discovery/candidates/${candidateId}/merge`)
          .set('Origin', origin)
          .send({ targetCandidateId: targetId })
      ).status,
    ).toBe(201);
  });

  it('bounds pagination and validates identifiers', async () => {
    const invalidLimit = await request(testApp).get('/api/label-discovery/candidates?limit=1000');
    const invalidId = await request(testApp).get('/api/label-discovery/candidates/not-a-uuid');
    expect(invalidLimit.status).toBe(400);
    expect(invalidId.status).toBe(400);
  });
});
