import { describe, expect, it } from 'vitest';

import {
  redactSentryText,
  sanitizeSentryUrl,
  scrubSentryEvent,
  scrubSentrySpan,
} from '../src/observability/sentryPrivacy.js';
import { captureApiException, closeSentry, isSentryEnabled } from '../src/observability/sentry.js';

describe('API Sentry privacy', () => {
  it('removes Gmail and OAuth request data before an event leaves the process', () => {
    const event = scrubSentryEvent({
      request: {
        url: 'https://api.example.com/api/gmail/messages?access_token=secret-token',
        method: 'POST',
        headers: { authorization: 'Bearer secret-token' },
        cookies: { mailmind_session: 'secret-session' },
        query_string: 'access_token=secret-token',
        data: { subject: 'private subject', snippet: 'private body' },
      },
      user: { id: 'private-user', email: 'private@example.com' },
      extra: { gmailMessage: 'private body', refreshToken: 'secret-refresh' },
      contexts: {
        trace: { trace_id: 'safe-trace', span_id: 'safe-span' },
        gmail: { subject: 'private subject' },
      },
      exception: {
        values: [{ type: 'Error', value: 'Failed for private@example.com token=secret-token' }],
      },
      breadcrumbs: [
        {
          category: 'console',
          message: 'private@example.com secret-token',
        },
        {
          category: 'navigation',
          message: 'private subject that must not leave the process',
        },
        {
          category: 'http',
          data: {
            method: 'GET',
            url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/private-id?token=secret',
          },
        },
      ],
      tags: {
        operation: 'gmail_sync',
        account_id: 'private-user',
      },
    });

    expect(event.request).toEqual({
      method: 'POST',
      url: 'https://api.example.com/api/gmail/[REDACTED_PATH]',
    });
    expect(event.user).toBeUndefined();
    expect(event.extra).toBeUndefined();
    expect(event.contexts).toEqual({
      trace: { trace_id: 'safe-trace', span_id: 'safe-span' },
    });
    expect(event.tags).toEqual({ operation: 'gmail_sync' });
    expect(event.exception?.values?.[0]?.value).toBe('Sensitive MailMind operation failed');
    expect(JSON.stringify(event)).not.toMatch(
      /secret-token|secret-session|secret-refresh|private subject|private body|private@example\.com|private-id/,
    );
  });

  it('redacts secrets from text, URLs, and span data', () => {
    expect(
      redactSentryText(
        'Bearer abc.def code=oauth-code user@example.com https://example.com/path?state=secret',
      ),
    ).toBe('Bearer [REDACTED] code=[REDACTED] [REDACTED_EMAIL] https://example.com/path');
    expect(sanitizeSentryUrl('/api/auth/callback?code=secret')).toBe('/api/auth/[REDACTED_PATH]');
    expect(sanitizeSentryUrl('/api/classification/messages/private-id/reclassify')).toBe(
      '/api/classification/[REDACTED_PATH]',
    );
    expect(redactSentryText('POST /api/classification/messages/private-id/reclassify')).toBe(
      'POST /api/classification/[REDACTED_PATH]',
    );

    const span = scrubSentrySpan({
      span_id: '1234567890abcdef',
      trace_id: '1234567890abcdef1234567890abcdef',
      start_timestamp: 1,
      timestamp: 2,
      description: 'GET https://example.com/api?token=secret',
      data: {
        'http.url': 'https://example.com/api?token=secret',
        authorization: 'Bearer secret',
        'user.id': 42,
        'http.status_code': 500,
      },
    });
    expect(span.description).toBe('GET https://example.com/api');
    expect(span.data).toEqual({
      'http.url': 'https://example.com/api',
      'http.status_code': 500,
    });
  });

  it('genericizes database errors that could contain failing row values', () => {
    const event = scrubSentryEvent({
      exception: {
        values: [
          {
            type: 'PrismaClientKnownRequestError',
            value: 'Failing row contains private Gmail metadata',
          },
        ],
      },
    });

    expect(event.exception?.values?.[0]?.value).toBe('Sensitive MailMind operation failed');
  });
});

describe('API Sentry disabled state', () => {
  it('is a clean no-op when SENTRY_DSN is absent', async () => {
    expect(isSentryEnabled()).toBe(false);
    expect(captureApiException(new Error('not sent'), { operation: 'test' })).toBeUndefined();
    await expect(closeSentry()).resolves.toBeUndefined();
  });
});
