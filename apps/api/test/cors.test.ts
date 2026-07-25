import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { app } from '../src/app.js';

const deployedWebOrigins = [
  'https://mailmindai.tech',
  'https://www.mailmindai.tech',
  'https://ai-email-organizer-for-gmail-web.vercel.app',
  'https://ai-email-organizer-for-gmail-5863pdgw2-lucky-5c2dbfb8.vercel.app',
];

describe('CORS', () => {
  it.each(deployedWebOrigins)('allows credentialed requests from %s', async (origin) => {
    const response = await request(app)
      .options('/api/auth/me')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'GET');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(origin);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not return CORS permission headers to an untrusted origin', async () => {
    const response = await request(app)
      .options('/api/auth/me')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'GET');

    expect(response.status).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
