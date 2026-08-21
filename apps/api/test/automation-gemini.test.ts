import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '../src/config/env.js';
import {
  GeminiAutomationProvider,
  estimatedCostMicroUsd,
  resetGeminiPacing,
} from '../src/features/automation/gemini-automation.provider.js';

const message = {
  key: 'm1',
  subject: 'Your receipt',
  sender: 'billing@example.com',
  senderDomain: 'example.com',
  snippet: 'Paid',
  isUnread: true,
  isImportant: false,
  hasAttachments: true,
};

const geminiResponse = (results: unknown, usageMetadata?: Record<string, number>) =>
  new Response(
    JSON.stringify({
      candidates: [
        { finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(results) }] } },
      ],
      ...(usageMetadata ? { usageMetadata } : {}),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

describe('GeminiAutomationProvider', () => {
  const originalKey = env.GEMINI_API_KEY;
  const originalRetries = env.GEMINI_MAX_RETRIES;
  const originalInterval = env.GEMINI_MIN_REQUEST_INTERVAL_MS;

  beforeEach(() => {
    env.GEMINI_API_KEY = 'test-gemini-key';
    // Pacing is exercised in its own test; elsewhere it would only add wall-clock time.
    env.GEMINI_MIN_REQUEST_INTERVAL_MS = 0;
    resetGeminiPacing();
  });

  afterEach(() => {
    env.GEMINI_API_KEY = originalKey;
    env.GEMINI_MAX_RETRIES = originalRetries;
    env.GEMINI_MIN_REQUEST_INTERVAL_MS = originalInterval;
    vi.unstubAllGlobals();
  });

  it('requests constrained JSON from the configured model and maps usageMetadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      geminiResponse(
        {
          results: [
            {
              key: 'm1',
              labelName: 'Receipts',
              confidence: 0.94,
              explanation: 'Receipt metadata.',
              reasonCodes: ['RECEIPT_SIGNAL'],
            },
          ],
        },
        { promptTokenCount: 120, candidatesTokenCount: 30, cachedContentTokenCount: 20 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GeminiAutomationProvider().classify([message], {
      labelNames: ['Receipts', 'Work'],
    });

    expect(result.classifications[0]).toMatchObject({
      key: 'm1',
      labelName: 'Receipts',
      confidence: 0.94,
    });
    expect(result.usage).toEqual({ inputTokens: 120, cachedInputTokens: 20, outputTokens: 30 });

    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent`,
    );
    expect(request.headers).toMatchObject({ 'x-goog-api-key': 'test-gemini-key' });
    const body = JSON.parse(String(request.body));
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    // The model may only choose an approved leaf or the no-fit sentinel.
    expect(
      body.generationConfig.responseSchema.properties.results.items.properties.labelName.enum,
    ).toEqual(['Receipts', 'Work', 'NONE']);
  });

  it('rejects a label outside the approved set even though the schema asked for one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        geminiResponse({
          results: [
            {
              key: 'm1',
              labelName: 'Invented',
              confidence: 0.99,
              explanation: 'Not an approved label.',
              reasonCodes: [],
            },
          ],
        }),
      ),
    );

    await expect(
      new GeminiAutomationProvider().classify([message], { labelNames: ['Receipts', 'Work'] }),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
  });

  it('rejects mismatched response keys instead of labelling the wrong message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        geminiResponse({
          results: [
            {
              key: 'wrong',
              labelName: 'Work',
              confidence: 0.9,
              explanation: 'Work.',
              reasonCodes: [],
            },
          ],
        }),
      ),
    );

    await expect(
      new GeminiAutomationProvider().classify([message], { labelNames: ['Receipts', 'Work'] }),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
  });

  it('rejects malformed JSON so the batch falls through to the review queue', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'not json{' }] } }],
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      new GeminiAutomationProvider().classify([message], { labelNames: ['Receipts', 'Work'] }),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
  });

  it('reports a truncated candidate rather than persisting a partial classification', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{}' }] } }],
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      new GeminiAutomationProvider().classify([message], { labelNames: ['Receipts', 'Work'] }),
    ).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
  });

  it('retries a transient 429 and recovers without duplicating classifications', async () => {
    env.GEMINI_MAX_RETRIES = 1;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', code: 429 } }), {
          status: 429,
          headers: { 'retry-after': '0' },
        }),
      )
      .mockResolvedValueOnce(
        geminiResponse({
          results: [
            {
              key: 'm1',
              labelName: 'Work',
              confidence: 0.91,
              explanation: 'Work metadata.',
              reasonCodes: ['WORK_SIGNAL'],
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GeminiAutomationProvider().classify([message], {
      labelNames: ['Receipts', 'Work'],
    });

    expect(result.classifications).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces a sustained 429 as a retryable rate limit with no credential in the error', async () => {
    env.GEMINI_MAX_RETRIES = 1;
    // A fresh Response per call: a body may only be read once, and the retry reads it again.
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', code: 429 } }), {
          status: 429,
          headers: { 'retry-after': '0', 'x-request-id': 'request-safe-id' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const error = await new GeminiAutomationProvider()
      .classify([message], { labelNames: ['Receipts', 'Work'] })
      .catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
      providerStatus: 429,
      providerCode: 'RESOURCE_EXHAUSTED',
      requestId: 'request-safe-id',
      retryable: true,
    });
    expect(String(error)).not.toContain('test-gemini-key');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry invalid credentials', async () => {
    env.GEMINI_MAX_RETRIES = 2;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED', code: 403 } }), {
        status: 403,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new GeminiAutomationProvider().classify([message], { labelNames: ['Receipts', 'Work'] }),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTHENTICATION_FAILED', retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a timeout as an unavailable provider rather than hanging the run', async () => {
    env.GEMINI_MAX_RETRIES = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' })),
    );

    await expect(
      new GeminiAutomationProvider().classify([message], { labelNames: ['Receipts', 'Work'] }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('refuses to call the provider when no label has been approved', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new GeminiAutomationProvider().classify([message], { labelNames: [] }),
    ).rejects.toMatchObject({ code: 'AUTOMATION_NO_APPROVED_LABELS' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('paces consecutive requests so the free tier per-minute cap is respected proactively', async () => {
    env.GEMINI_MIN_REQUEST_INTERVAL_MS = 120;
    resetGeminiPacing();
    const callTimes: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        callTimes.push(Date.now());
        return Promise.resolve(
          geminiResponse({
            results: [
              {
                key: 'm1',
                labelName: 'Work',
                confidence: 0.9,
                explanation: 'Work.',
                reasonCodes: [],
              },
            ],
          }),
        );
      }),
    );

    const provider = new GeminiAutomationProvider();
    await provider.classify([message], { labelNames: ['Work'] });
    await provider.classify([message], { labelNames: ['Work'] });

    expect(callTimes).toHaveLength(2);
    expect(callTimes[1]! - callTimes[0]!).toBeGreaterThanOrEqual(100);
  });

  it('counts a slow request against the interval instead of adding the wait to it', async () => {
    // The interval caps requests per minute, so it is measured from one request starting to the
    // next. Sleeping the full interval *after* a slow round trip would pace on top of the request
    // time and throttle a run well below the quota it is allowed to use.
    env.GEMINI_MIN_REQUEST_INTERVAL_MS = 200;
    resetGeminiPacing();
    const requestDurationMs = 260;
    const callTimes: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        callTimes.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, requestDurationMs));
        return geminiResponse({
          results: [
            {
              key: 'm1',
              labelName: 'Work',
              confidence: 0.9,
              explanation: 'Work.',
              reasonCodes: [],
            },
          ],
        });
      }),
    );

    const provider = new GeminiAutomationProvider();
    await provider.classify([message], { labelNames: ['Work'] });
    await provider.classify([message], { labelNames: ['Work'] });

    // The request already outran the interval, so the second call waits for nothing. Allowing the
    // interval again on top would put this at 460ms rather than ~260ms.
    const spacing = callTimes[1]! - callTimes[0]!;
    expect(spacing).toBeGreaterThanOrEqual(requestDurationMs);
    expect(spacing).toBeLessThan(requestDurationMs + env.GEMINI_MIN_REQUEST_INTERVAL_MS);
  });

  it('derives a non-zero notional cost so the run budget can still bound usage', () => {
    // 1M uncached input + 1M output at the recorded paid rates: 300000 + 2500000 micro-USD.
    expect(
      estimatedCostMicroUsd({
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 1_000_000,
      }),
    ).toBe(2_800_000);
    // Cached input is priced an order of magnitude lower than fresh input.
    expect(
      estimatedCostMicroUsd({
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 0,
      }),
    ).toBe(30_000);
  });
});
