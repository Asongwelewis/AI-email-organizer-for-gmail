import { env } from '@api/config/env.js';
import { AppError } from '@api/errors/AppError.js';
import type { createGoogleOAuthClient } from './google-oauth.client.js';
import type { VerifiedGoogleIdentity } from './google.types.js';

const ACCEPTED_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

export async function verifyGoogleIdentity(
  client: ReturnType<typeof createGoogleOAuthClient>,
  idToken: string | null | undefined,
): Promise<VerifiedGoogleIdentity> {
  if (!idToken) {
    throw new AppError('AUTH_GOOGLE_IDENTITY_INVALID', 'Google identity verification failed.', 401);
  }
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (
      !payload?.sub ||
      !payload.email ||
      payload.email_verified !== true ||
      payload.aud !== env.GOOGLE_CLIENT_ID ||
      !payload.iss ||
      !ACCEPTED_ISSUERS.has(payload.iss) ||
      !payload.exp ||
      payload.exp <= nowSeconds
    ) {
      throw new Error('invalid identity claims');
    }
    return {
      subject: payload.sub,
      email: payload.email.trim().toLowerCase(),
      emailVerified: true,
      displayName: payload.name?.trim() || null,
      avatarUrl: payload.picture ?? null,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('AUTH_GOOGLE_IDENTITY_INVALID', 'Google identity verification failed.', 401);
  }
}
