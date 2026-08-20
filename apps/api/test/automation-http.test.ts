import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  status: vi.fn(),
  run: vi.fn(),
  start: vi.fn(),
  reviewQueue: vi.fn(),
  approve: vi.fn(),
  skip: vi.fn(),
}));

vi.mock('../src/sessions/session.service.js', () => ({
  sessionService: { authenticate: mocks.authenticate },
}));
vi.mock('../src/features/automation/automation.service.js', () => ({
  automationService: mocks,
}));

import { automationRouter } from '../src/features/automation/automation.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use((request_, _response, next) => {
  request_.requestId = 'request-id';
  next();
});
app.use('/api/automation', automationRouter);
app.use(errorHandler);

const actionId = '00000000-0000-4000-8000-000000000001';

describe('automation HTTP routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.authenticate.mockResolvedValue({
      id: 'session-id',
      user: { id: 'user-id', email: 'user@example.com', status: 'ACTIVE' },
    });
    mocks.status.mockResolvedValue({ gmailConnected: true, enabled: true, running: false });
    mocks.reviewQueue.mockResolvedValue({ items: [] });
    mocks.start.mockResolvedValue({
      runId: actionId,
      state: 'RUNNING',
      kind: 'AUTOMATION_FILING',
      startedAt: '2026-08-20T00:00:00.000Z',
      alreadyRunning: false,
    });
    mocks.approve.mockResolvedValue({ success: true });
    mocks.skip.mockResolvedValue({ success: true });
  });

  it('returns connection state with explicit no-cache headers', async () => {
    const response = await request(app).get('/api/automation/status');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toMatchObject({ gmailConnected: true });
  });

  it('protects mutations by origin and validates the approval body', async () => {
    const denied = await request(app)
      .post('/api/automation/run')
      .set('Origin', 'https://evil.example');
    expect(denied.status).toBe(403);

    const invalid = await request(app)
      .post(`/api/automation/review/${actionId}/approve`)
      .set('Origin', 'http://localhost:5173')
      .send({ category: 'WORK' });
    expect(invalid.status).toBe(400);
    expect(mocks.approve).not.toHaveBeenCalled();

    const valid = await request(app)
      .post(`/api/automation/review/${actionId}/approve`)
      .set('Origin', 'http://localhost:5173')
      .send({ labelName: 'Invoices' });
    expect(valid.status).toBe(200);
    expect(mocks.approve).toHaveBeenCalledWith('user-id', actionId, 'Invoices');
  });

  // Filing outlives a browser request, so the endpoint accepts and hands back a run id to poll.
  it('accepts a filing run with 202 and a run id to poll', async () => {
    const response = await request(app)
      .post('/api/automation/run')
      .set('Origin', 'http://localhost:5173');
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ runId: actionId, state: 'RUNNING' });
  });

  // Preconditions the caller can act on still answer synchronously rather than in a run record.
  it('refuses to run before any label is approved', async () => {
    const { AppError } = await import('../src/errors/AppError.js');
    mocks.start.mockRejectedValueOnce(
      new AppError('AUTOMATION_NO_APPROVED_LABELS', 'Confirm labels first.', 409),
    );
    const response = await request(app)
      .post('/api/automation/run')
      .set('Origin', 'http://localhost:5173');
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('AUTOMATION_NO_APPROVED_LABELS');
  });
});
