import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  status: vi.fn(),
  results: vi.fn(),
  result: vi.fn(),
  run: vi.fn(),
  reclassify: vi.fn(),
  correct: vi.fn(),
}));

vi.mock('../src/sessions/session.service.js', () => ({
  sessionService: { authenticate: mocks.authenticate },
}));
vi.mock('../src/features/classification/classification.service.js', () => ({
  classificationService: mocks,
}));

import { classificationRouter } from '../src/features/classification/classification.routes.js';
import { AppError } from '../src/errors/AppError.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

const testApp = express();
testApp.use(express.json());
testApp.use(cookieParser());
testApp.use((request_, _response, next) => {
  request_.requestId = 'request-id';
  next();
});
testApp.use('/api/classification', classificationRouter);
testApp.use(errorHandler);

const resultId = '00000000-0000-4000-8000-000000000001';

describe('classification HTTP routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.authenticate.mockResolvedValue({
      id: 'session-id',
      user: { id: 'user-id', email: 'user@example.com', status: 'ACTIVE' },
    });
    mocks.status.mockResolvedValue({
      enabled: false,
      provider: 'disabled',
      classifiedCount: 2,
      reviewRequiredCount: 1,
    });
    mocks.results.mockResolvedValue({ results: [], nextCursor: null });
    mocks.run.mockResolvedValue({ success: true, runId: resultId });
    mocks.correct.mockResolvedValue({ id: resultId });
  });

  it('requires authentication', async () => {
    mocks.authenticate.mockRejectedValueOnce(
      new AppError('AUTHENTICATION_REQUIRED', 'Sign in.', 401),
    );
    const response = await request(testApp).get('/api/classification/status');
    expect(response.status).toBe(401);
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it('returns a safe status and bounded result filters', async () => {
    const status = await request(testApp).get('/api/classification/status');
    const results = await request(testApp).get(
      '/api/classification/results?requiresReview=true&limit=10',
    );
    expect(status.status).toBe(200);
    expect(JSON.stringify(status.body)).not.toMatch(/apiKey|token|prompt/i);
    expect(results.status).toBe(200);
    expect(mocks.results).toHaveBeenCalledWith(
      'user-id',
      expect.objectContaining({ requiresReview: true, limit: 10 }),
    );
  });

  it('rejects an untrusted run origin', async () => {
    const response = await request(testApp)
      .post('/api/classification/run')
      .set('Origin', 'https://evil.example');
    expect(response.status).toBe(403);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('runs classification from the trusted UI', async () => {
    const response = await request(testApp)
      .post('/api/classification/run')
      .set('Origin', 'http://localhost:5173');
    expect(response.status).toBe(200);
    expect(mocks.run).toHaveBeenCalledWith('user-id');
  });

  it('validates correction taxonomy before calling the service', async () => {
    const invalid = await request(testApp)
      .post(`/api/classification/results/${resultId}/correct`)
      .set('Origin', 'http://localhost:5173')
      .send({ category: 'UNKNOWN', recommendedAction: 'KEEP_IN_INBOX' });
    expect(invalid.status).toBe(400);
    expect(mocks.correct).not.toHaveBeenCalled();

    const valid = await request(testApp)
      .post(`/api/classification/results/${resultId}/correct`)
      .set('Origin', 'http://localhost:5173')
      .send({ category: 'WORK', recommendedAction: 'KEEP_IN_INBOX' });
    expect(valid.status).toBe(201);
    expect(mocks.correct).toHaveBeenCalledWith(
      'user-id',
      resultId,
      'WORK',
      'KEEP_IN_INBOX',
      undefined,
    );
  });
});
