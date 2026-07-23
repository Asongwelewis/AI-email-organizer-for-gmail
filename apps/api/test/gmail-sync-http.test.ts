import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  status: vi.fn(),
  initialSync: vi.fn(),
  incrementalSync: vi.fn(),
  initializeLabels: vi.fn(),
  profile: vi.fn(),
  labels: vi.fn(),
}));

vi.mock('../src/sessions/session.service.js', () => ({
  sessionService: { authenticate: mocks.authenticate },
}));
vi.mock('../src/integrations/gmail/gmail.service.js', () => ({
  gmailSyncService: mocks,
}));

import { gmailRouter } from '../src/integrations/gmail/gmail.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

const testApp = express();
testApp.use(cookieParser());
testApp.use((request_, _response, next) => {
  request_.requestId = 'request-id';
  next();
});
testApp.use('/api/gmail', gmailRouter);
testApp.use(errorHandler);

describe('Gmail synchronization HTTP routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.authenticate.mockResolvedValue({
      id: 'session-id',
      user: { id: 'user-id', email: 'user@example.com', status: 'ACTIVE' },
    });
    mocks.status.mockResolvedValue({
      status: 'READY',
      initialSyncCompleted: true,
      lastSuccessfulSyncAt: '2026-07-23T00:00:00.000Z',
      lastErrorCode: null,
      nextRetryAt: null,
      messageCount: 12,
      syncRunning: false,
    });
    mocks.initialSync.mockResolvedValue({ success: true, messagesUpserted: 12 });
  });

  it('returns a secret-free sync status', async () => {
    const response = await request(testApp)
      .get('/api/gmail/sync/status')
      .set('Cookie', 'mailmind_session=valid');
    expect(response.status).toBe(200);
    expect(response.body.messageCount).toBe(12);
    expect(JSON.stringify(response.body)).not.toMatch(/token|ciphertext|googleSubject/i);
  });

  it('requires a trusted origin for state-changing sync actions', async () => {
    const response = await request(testApp)
      .post('/api/gmail/sync/initial')
      .set('Origin', 'https://evil.example')
      .set('Cookie', 'mailmind_session=valid');
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CSRF_ORIGIN_INVALID');
    expect(mocks.initialSync).not.toHaveBeenCalled();
  });

  it('starts an initial sync for the authenticated user', async () => {
    const response = await request(testApp)
      .post('/api/gmail/sync/initial')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', 'mailmind_session=valid');
    expect(response.status).toBe(200);
    expect(mocks.initialSync).toHaveBeenCalledWith('user-id');
  });
});
