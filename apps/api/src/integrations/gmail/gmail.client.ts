import { google } from 'googleapis';

import { env } from '@api/config/env.js';
import { googleTokenService } from '@api/integrations/google/google-token.service.js';
import { createGoogleOAuthClient } from '@api/integrations/google/google-oauth.client.js';
import { classifyGmailError } from './gmail.errors.js';
import type { GmailClient } from './gmail.types.js';

/**
 * A Gmail client that can outlive one access token.
 *
 * The initial backfill walks every page of a mailbox and routinely runs past the hour a Google
 * access token lasts. A client given only an access token cannot renew it, so the first request
 * after expiry returns 401, which reads as a revoked grant and marks the account as needing
 * reauthentication — while the refresh token was valid the whole time. Passing the refresh token
 * and the expiry lets google-auth-library renew before that happens.
 */
export async function createGmailClient(accountId: string): Promise<GmailClient> {
  const credentials = await googleTokenService.getGmailClientCredentials(accountId);
  const auth = createGoogleOAuthClient('GMAIL');
  auth.setCredentials({
    access_token: credentials.accessToken,
    ...(credentials.refreshToken ? { refresh_token: credentials.refreshToken } : {}),
    ...(credentials.expiryDate ? { expiry_date: credentials.expiryDate } : {}),
  });
  // A renewal is worth keeping: without this the token lives only in this process and the next
  // one refreshes again. Failures are ignored because the in-memory token already works.
  auth.on('tokens', (tokens) => {
    if (!tokens.access_token) return;
    void googleTokenService
      .storeRefreshedAccessToken(accountId, tokens.access_token, tokens.expiry_date ?? null)
      .catch(() => undefined);
  });
  return google.gmail({ version: 'v1', auth });
}

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export async function withGmailRetry<T>(
  operation: () => Promise<T>,
  sleep: (milliseconds: number) => Promise<void> = delay,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      const classified = classifyGmailError(error);
      if (!classified.retryable || attempt >= env.GMAIL_SYNC_MAX_RETRIES) throw classified;
      const jitter = Math.floor(Math.random() * env.GMAIL_SYNC_RETRY_BASE_MS);
      await sleep(env.GMAIL_SYNC_RETRY_BASE_MS * 2 ** attempt + jitter);
      attempt += 1;
    }
  }
}
