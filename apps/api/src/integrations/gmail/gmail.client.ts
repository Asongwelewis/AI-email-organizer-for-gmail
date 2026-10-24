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

/** Rate limits get more attempts than other transient failures, and much longer waits. */
const RATE_LIMIT_MAX_RETRIES = 5;
/** Never wait longer than this for one attempt, whatever Retry-After says. */
const MAX_WAIT_MS = 60_000;

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
      const rateLimited = classified.code === 'GMAIL_RATE_LIMITED';
      const maxRetries = rateLimited
        ? Math.max(env.GMAIL_SYNC_MAX_RETRIES, RATE_LIMIT_MAX_RETRIES)
        : env.GMAIL_SYNC_MAX_RETRIES;
      if (!classified.retryable || attempt >= maxRetries) throw classified;
      const base = rateLimited ? env.GMAIL_RATE_LIMIT_RETRY_BASE_MS : env.GMAIL_SYNC_RETRY_BASE_MS;
      const backoff = base * 2 ** attempt + Math.floor(Math.random() * base);
      await sleep(Math.min(MAX_WAIT_MS, Math.max(backoff, classified.retryAfterMs ?? 0)));
      attempt += 1;
    }
  }
}

/**
 * Holds a batch of Gmail calls to the per-mailbox budget: a batch that spent `units` finishes no
 * sooner than `units / GMAIL_SYNC_UNITS_PER_SECOND` seconds after it started.
 */
export async function paceGmailUnits(
  units: number,
  startedAt: number,
  sleep: (milliseconds: number) => Promise<void> = delay,
): Promise<void> {
  if (env.GMAIL_SYNC_UNITS_PER_SECOND <= 0) return;
  const minimum = (units / env.GMAIL_SYNC_UNITS_PER_SECOND) * 1000;
  const remaining = minimum - (Date.now() - startedAt);
  if (remaining > 0) await sleep(remaining);
}
