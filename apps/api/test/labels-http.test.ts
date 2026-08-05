import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  list: vi.fn(),
  propose: vi.fn(),
  confirm: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../src/sessions/session.service.js', () => ({
  sessionService: { authenticate: mocks.authenticate },
}));
vi.mock('../src/features/labels/labels.service.js', () => ({
  labelsService: mocks,
}));
// Route wiring is under test here, not the shared limiter; its window would otherwise
// spill across cases in this file.
vi.mock('../src/middleware/rateLimiters.js', () => {
  const passthrough = (_request: unknown, _response: unknown, next: () => void) => next();
  return { labelsReadLimiter: passthrough, labelsMutationLimiter: passthrough };
});

import { AppError } from '../src/errors/AppError.js';
import { labelsRouter } from '../src/features/labels/labels.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use((request_, _response, next) => {
  request_.requestId = 'request-id';
  next();
});
app.use('/api/labels', labelsRouter);
app.use(errorHandler);

const labelId = '00000000-0000-4000-8000-000000000010';
const origin = 'http://localhost:5173';
const overview = {
  maxLabels: 25,
  labels: [
    {
      id: labelId,
      leafName: 'Invoices',
      fullPath: 'MailMind/Invoices',
      source: 'AI_PROPOSED',
      gmailLabelId: 'Label_1',
      createdAt: '2026-07-31T00:00:00.000Z',
    },
  ],
  proposals: [],
};

describe('labels HTTP routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.authenticate.mockResolvedValue({
      id: 'session-id',
      user: { id: 'user-id', email: 'user@example.com', status: 'ACTIVE' },
    });
    mocks.list.mockResolvedValue(overview);
    mocks.propose.mockResolvedValue(overview);
    mocks.confirm.mockResolvedValue(overview);
    mocks.rename.mockResolvedValue(overview.labels[0]);
    mocks.remove.mockResolvedValue({ success: true, gmailLabelRetained: true });
  });

  it('requires a session for every label route', async () => {
    mocks.authenticate.mockRejectedValue(
      new AppError('AUTH_REQUIRED', 'Authentication is required.', 401),
    );
    const response = await request(app).get('/api/labels');
    expect(response.status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('returns the approved set and proposals without caching', async () => {
    const response = await request(app).get('/api/labels');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toMatchObject({ maxLabels: 25 });
    expect(response.body.labels[0]).toMatchObject({ leafName: 'Invoices' });
  });

  it('protects every mutation with a trusted origin', async () => {
    for (const call of [
      request(app).post('/api/labels/propose').set('Origin', 'https://evil.example'),
      request(app)
        .post('/api/labels/confirm')
        .set('Origin', 'https://evil.example')
        .send({ labels: [{ leafName: 'Invoices', source: 'USER_CREATED' }] }),
      request(app)
        .patch(`/api/labels/${labelId}`)
        .set('Origin', 'https://evil.example')
        .send({ leafName: 'Bills' }),
      request(app).delete(`/api/labels/${labelId}`).set('Origin', 'https://evil.example'),
    ]) {
      const response = await call;
      expect(response.status).toBe(403);
    }
    expect(mocks.propose).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it('proposes a label set for the authenticated user', async () => {
    const response = await request(app).post('/api/labels/propose').set('Origin', origin);
    expect(response.status).toBe(200);
    expect(mocks.propose).toHaveBeenCalledWith('user-id');
  });

  it('confirms a validated label set', async () => {
    const response = await request(app)
      .post('/api/labels/confirm')
      .set('Origin', origin)
      .send({
        labels: [
          { leafName: 'Invoices', source: 'AI_PROPOSED' },
          { leafName: 'Flights', source: 'USER_CREATED' },
        ],
      });
    expect(response.status).toBe(200);
    expect(mocks.confirm).toHaveBeenCalledWith('user-id', [
      { leafName: 'Invoices', source: 'AI_PROPOSED' },
      { leafName: 'Flights', source: 'USER_CREATED' },
    ]);
  });

  it('rejects malformed confirm payloads with 400', async () => {
    for (const body of [
      { labels: [] },
      { labels: [{ leafName: '', source: 'USER_CREATED' }] },
      { labels: [{ leafName: 'Invoices', source: 'SOMETHING_ELSE' }] },
      { labels: [{ leafName: 'Invoices' }] },
      { labels: [{ leafName: 'Invoices', source: 'USER_CREATED', extra: true }] },
    ]) {
      const response = await request(app)
        .post('/api/labels/confirm')
        .set('Origin', origin)
        .send(body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('LABEL_VALIDATION_FAILED');
    }
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it('surfaces similarity conflicts as 409', async () => {
    mocks.confirm.mockRejectedValue(
      new AppError('LABEL_DUPLICATE', '"Invoice" and "Invoices" are too similar.', 409),
    );
    const response = await request(app)
      .post('/api/labels/confirm')
      .set('Origin', origin)
      .send({
        labels: [
          { leafName: 'Invoice', source: 'USER_CREATED' },
          { leafName: 'Invoices', source: 'USER_CREATED' },
        ],
      });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('LABEL_DUPLICATE');
  });

  it('surfaces an unusable name as 400', async () => {
    mocks.confirm.mockRejectedValue(
      new AppError('LABEL_NAME_INVALID', '"stuff" is not a usable label name.', 400),
    );
    const response = await request(app)
      .post('/api/labels/confirm')
      .set('Origin', origin)
      .send({ labels: [{ leafName: 'stuff', source: 'USER_CREATED' }] });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('LABEL_NAME_INVALID');
  });

  it('renames a label and rejects a non-uuid id', async () => {
    const renamed = await request(app)
      .patch(`/api/labels/${labelId}`)
      .set('Origin', origin)
      .send({ leafName: 'Bills' });
    expect(renamed.status).toBe(200);
    expect(mocks.rename).toHaveBeenCalledWith('user-id', labelId, 'Bills');

    const invalid = await request(app)
      .patch('/api/labels/not-a-uuid')
      .set('Origin', origin)
      .send({ leafName: 'Bills' });
    expect(invalid.status).toBe(400);
  });

  it('deletes the MailMind record and reports the Gmail label was retained', async () => {
    const response = await request(app).delete(`/api/labels/${labelId}`).set('Origin', origin);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, gmailLabelRetained: true });
    expect(mocks.remove).toHaveBeenCalledWith('user-id', labelId);
  });
});
