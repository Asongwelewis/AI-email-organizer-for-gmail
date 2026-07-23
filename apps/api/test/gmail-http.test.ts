import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  beginConnection: vi.fn(),
  completeConnection: vi.fn(),
  denyConnection: vi.fn(),
  status: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('../src/sessions/session.service.js', () => ({
  sessionService: { authenticate: mocks.authenticate },
}));
vi.mock('../src/integrations/google/google-login.service.js', () => ({
  googleGmailService: {
    beginConnection: mocks.beginConnection,
    completeConnection: mocks.completeConnection,
    denyConnection: mocks.denyConnection,
    status: mocks.status,
    disconnect: mocks.disconnect,
  },
}));

import { authenticationRequired } from '../src/errors/AppError.js';
import { googleIntegrationRouter } from '../src/integrations/google/google-integration.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

const authenticated = {
  id: 'session-id',
  user: {
    id: 'user-id',
    email: 'user@example.com',
    displayName: null,
    avatarUrl: null,
    status: 'ACTIVE' as const,
  },
};

const testApp = express();
testApp.use(cookieParser());
testApp.use((request_, _response, next) => {
  request_.requestId = 'request-id';
  next();
});
testApp.use('/api/integrations/google', googleIntegrationRouter);
testApp.use(errorHandler);

describe('Gmail integration HTTP routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.authenticate.mockImplementation(async (request_) => {
      const cookies = request_.cookies as Record<string, string>;
      if (cookies['mailmind_session'] !== 'valid-session') throw authenticationRequired();
      return authenticated;
    });
    mocks.beginConnection.mockResolvedValue('https://accounts.google.test/gmail-consent');
    mocks.completeConnection.mockResolvedValue({
      status: 'gmail_connected',
      redirectPath: '/settings/connections',
    });
    mocks.denyConnection.mockResolvedValue('/auth/callback');
    mocks.status.mockResolvedValue({
      connected: true,
      email: 'connected@gmail.com',
      status: 'CONNECTED',
      grantedScopes: ['https://www.googleapis.com/auth/gmail.modify'],
      requiresReauthentication: false,
    });
    mocks.disconnect.mockResolvedValue(undefined);
  });

  it('requires MailMind authentication to start Gmail authorization', async () => {
    expect((await request(testApp).get('/api/integrations/google/connect')).status).toBe(401);
    const connected = await request(testApp)
      .get('/api/integrations/google/connect')
      .set('Cookie', 'mailmind_session=valid-session');
    expect(connected.status).toBe(302);
    expect(connected.headers['location']).toBe('https://accounts.google.test/gmail-consent');
  });

  it('preserves the MailMind cookie when Gmail consent is denied', async () => {
    const response = await request(testApp)
      .get('/api/integrations/google/callback?error=access_denied&state=denied-state')
      .set('Cookie', 'mailmind_session=valid-session');
    expect(response.status).toBe(302);
    expect(response.headers['location']).toContain('status=gmail_denied');
    expect(response.headers['location']).toContain('/auth/callback');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(mocks.denyConnection).toHaveBeenCalledWith(expect.anything(), 'denied-state');
  });

  it('redirects successful callbacks using only predefined status', async () => {
    const response = await request(testApp)
      .get('/api/integrations/google/callback?code=authorization-code&state=oauth-state')
      .set('Cookie', 'mailmind_session=valid-session');
    expect(response.status).toBe(302);
    expect(response.headers['location']).toContain('status=gmail_connected');
    expect(response.headers['location']).not.toContain('authorization-code');
    expect(response.headers['location']).not.toContain('oauth-state');
  });

  it('requires the initiating MailMind session for a successful Gmail callback', async () => {
    const response = await request(testApp).get(
      '/api/integrations/google/callback?code=authorization-code&state=oauth-state',
    );
    expect(response.status).toBe(302);
    expect(response.headers['location']).toContain('status=gmail_connection_failed');
    expect(mocks.completeConnection).not.toHaveBeenCalled();
  });

  it('returns safe status and disconnects without clearing the MailMind session', async () => {
    const status = await request(testApp)
      .get('/api/integrations/google/status')
      .set('Cookie', 'mailmind_session=valid-session');
    expect(status.status).toBe(200);
    expect(JSON.stringify(status.body)).not.toMatch(/token|ciphertext|authTag|googleSubject/i);

    const disconnected = await request(testApp)
      .post('/api/integrations/google/disconnect')
      .set('Cookie', 'mailmind_session=valid-session');
    expect(disconnected.status).toBe(200);
    expect(disconnected.body).toEqual({ success: true });
    expect(disconnected.headers['set-cookie']).toBeUndefined();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });

  it('rejects Gmail disconnect from an untrusted browser origin', async () => {
    const response = await request(testApp)
      .post('/api/integrations/google/disconnect')
      .set('Origin', 'https://evil.example')
      .set('Cookie', 'mailmind_session=valid-session');
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CSRF_ORIGIN_INVALID');
    expect(mocks.disconnect).not.toHaveBeenCalled();
  });
});
