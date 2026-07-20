import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { oauthStartLimiter } from '../src/middleware/rateLimiters.js';

describe('authentication rate limiting', () => {
  it('returns a typed 429 response after the configured OAuth-start limit', async () => {
    const limitedApp = express();
    limitedApp.get('/oauth-start', oauthStartLimiter, (_request, response) => {
      response.json({ ok: true });
    });
    for (let index = 0; index < 10; index += 1) {
      expect((await request(limitedApp).get('/oauth-start')).status).toBe(200);
    }
    const limited = await request(limitedApp).get('/oauth-start');
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please try again later.',
      },
    });
  });
});
