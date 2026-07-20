import { describe, expect, it, vi } from 'vitest';

import { verifyGoogleIdentity } from '../src/integrations/google/google-identity.service.js';
import { env } from '../src/config/env.js';

const validPayload = () => ({
  sub: 'google-subject',
  email: ' User@Example.com ',
  email_verified: true,
  aud: env.GOOGLE_CLIENT_ID,
  iss: 'https://accounts.google.com',
  exp: Math.floor(Date.now() / 1000) + 300,
  name: 'Example User',
  picture: 'https://example.test/avatar.png',
});

function clientWithPayload(payload: Record<string, unknown>) {
  return {
    verifyIdToken: vi.fn().mockResolvedValue({ getPayload: () => payload }),
  } as never;
}

describe('Google identity verification', () => {
  it('validates claims and normalizes the verified email', async () => {
    const identity = await verifyGoogleIdentity(clientWithPayload(validPayload()), 'id-token');
    expect(identity).toEqual({
      subject: 'google-subject',
      email: 'user@example.com',
      emailVerified: true,
      displayName: 'Example User',
      avatarUrl: 'https://example.test/avatar.png',
    });
  });

  it.each([
    ['missing subject', { sub: undefined }],
    ['missing email', { email: undefined }],
    ['unverified email', { email_verified: false }],
    ['wrong audience', { aud: 'another-client' }],
    ['wrong issuer', { iss: 'https://attacker.example' }],
    ['expired token', { exp: Math.floor(Date.now() / 1000) - 1 }],
  ])('rejects %s', async (_description, override) => {
    await expect(
      verifyGoogleIdentity(clientWithPayload({ ...validPayload(), ...override }), 'id-token'),
    ).rejects.toMatchObject({ code: 'AUTH_GOOGLE_IDENTITY_INVALID' });
  });

  it('requires an ID token and never includes it in the error', async () => {
    const secret = 'sensitive-id-token';
    const client = {
      verifyIdToken: vi.fn().mockRejectedValue(new Error('verification failed')),
    } as never;
    try {
      await verifyGoogleIdentity(client, secret);
    } catch (error) {
      expect(error).toMatchObject({ code: 'AUTH_GOOGLE_IDENTITY_INVALID' });
      expect(String(error)).not.toContain(secret);
    }
    await expect(verifyGoogleIdentity(client, null)).rejects.toMatchObject({
      code: 'AUTH_GOOGLE_IDENTITY_INVALID',
    });
  });
});
