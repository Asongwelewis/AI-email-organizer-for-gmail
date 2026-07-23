import { google } from 'googleapis';

import { env } from '@api/config/env.js';
import { googleTokenService } from '@api/integrations/google/google-token.service.js';
import { createGoogleOAuthClient } from '@api/integrations/google/google-oauth.client.js';
import { classifyGmailError } from './gmail.errors.js';
import type { GmailClient } from './gmail.types.js';

export async function createGmailClient(accountId: string): Promise<GmailClient> {
  const accessToken = await googleTokenService.getValidAccessTokenForConnectedAccount(accountId);
  const auth = createGoogleOAuthClient('GMAIL');
  auth.setCredentials({ access_token: accessToken });
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
