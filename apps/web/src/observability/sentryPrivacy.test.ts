import { describe, expect, it } from 'vitest';

import {
  isSentryDsnConfigured,
  redactSentryText,
  sanitizeSentryUrl,
  scrubSentryEvent,
  scrubSentrySpan,
} from './sentryPrivacy';

describe('frontend Sentry privacy', () => {
  it('treats missing and blank DSNs as disabled', () => {
    expect(isSentryDsnConfigured(undefined)).toBe(false);
    expect(isSentryDsnConfigured('   ')).toBe(false);
    expect(isSentryDsnConfigured('https://public@example.ingest.sentry.io/1')).toBe(true);
  });

  it('removes OAuth and Gmail context from browser events', () => {
    const event = scrubSentryEvent({
      request: {
        url: 'https://mailmindai.tech/auth/callback?code=oauth-code&state=secret-state',
        method: 'GET',
        headers: { cookie: 'mailmind_session=secret-session' },
        query_string: 'code=oauth-code',
      },
      user: { id: 'private-user', email: 'private@example.com' },
      extra: { routeError: { subject: 'private subject', snippet: 'private body' } },
      contexts: {
        trace: { trace_id: 'safe-trace', span_id: 'safe-span' },
        gmail: { subject: 'private subject' },
      },
      exception: {
        values: [{ value: 'OAuth failed for private@example.com code=oauth-code' }],
      },
      breadcrumbs: [
        {
          category: 'navigation',
          message: 'private subject that must not leave the browser',
        },
      ],
      tags: {
        source: 'react-router-error-element',
        account_id: 'private-user',
      },
    });

    expect(event.request).toEqual({
      method: 'GET',
      url: 'https://mailmindai.tech/auth/[REDACTED_PATH]',
    });
    expect(event.user).toBeUndefined();
    expect(event.extra).toBeUndefined();
    expect(event.contexts).toEqual({
      trace: { trace_id: 'safe-trace', span_id: 'safe-span' },
    });
    expect(event.tags).toEqual({ source: 'react-router-error-element' });
    expect(event.exception?.values?.[0]?.value).toBe('Sensitive MailMind operation failed');
    expect(JSON.stringify(event)).not.toMatch(
      /oauth-code|secret-state|secret-session|private subject|private body|private@example\.com/,
    );
  });

  it('redacts text, URL query strings, and sensitive span attributes', () => {
    expect(
      redactSentryText(
        'Bearer abc.def state=oauth-state user@example.com https://example.com/path?token=secret',
      ),
    ).toBe('Bearer [REDACTED] state=[REDACTED] [REDACTED_EMAIL] https://example.com/path');
    expect(sanitizeSentryUrl('/auth/callback?code=secret')).toBe('/auth/[REDACTED_PATH]');
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
        cookie: 'secret-session',
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
});
