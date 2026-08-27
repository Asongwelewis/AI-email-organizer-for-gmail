import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock('../src/config/logger.js', () => ({
  logger: logs,
  safeErrorDetails: () => ({}),
}));

import { env } from '../src/config/env.js';
import {
  requestGeminiJson,
  resetGeminiModelVersion,
  resetGeminiPacing,
} from '../src/integrations/gemini/gemini.client.js';

const response = (body: Record<string, unknown>) =>
  new Response(
    JSON.stringify({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"ok":true}' }] } }],
      ...body,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const call = () =>
  requestGeminiJson({
    systemInstruction: 'classify',
    payload: { messages: [] },
    responseSchema: { type: 'object' },
    maxOutputTokens: 100,
  });

/**
 * GEMINI_MODEL defaults to an alias Google repoints without warning. On an unattended scheduler
 * the only symptom of a swap is classification quality shifting for no nameable reason, so the
 * served model has to be knowable after the fact.
 */
describe('Gemini resolved model version', () => {
  const originalKey = env.GEMINI_API_KEY;
  const originalInterval = env.GEMINI_MIN_REQUEST_INTERVAL_MS;

  beforeEach(() => {
    vi.clearAllMocks();
    env.GEMINI_API_KEY = 'test-gemini-key';
    env.GEMINI_MIN_REQUEST_INTERVAL_MS = 0;
    resetGeminiPacing();
    resetGeminiModelVersion();
  });

  afterEach(() => {
    env.GEMINI_API_KEY = originalKey;
    env.GEMINI_MIN_REQUEST_INTERVAL_MS = originalInterval;
    vi.unstubAllGlobals();
  });

  it('returns the model that actually answered, not the alias that was asked for', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ modelVersion: 'gemini-3.5-flash-lite' })),
    );

    await expect(call()).resolves.toMatchObject({ modelVersion: 'gemini-3.5-flash-lite' });
  });

  it('logs the resolved model once rather than on every call of a backfill', async () => {
    vi.stubGlobal(
      'fetch',
      // A fresh Response per call: a body can only be read once.
      vi.fn(async () => response({ modelVersion: 'gemini-3.5-flash-lite' })),
    );

    await call();
    await call();
    await call();

    const resolved = logs.info.mock.calls.filter(([, message]) =>
      String(message).startsWith('gemini resolved model version'),
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.[0]).toMatchObject({
      configuredModel: env.GEMINI_MODEL,
      modelVersion: 'gemini-3.5-flash-lite',
      previousModelVersion: null,
    });
  });

  // The line this whole mechanism exists to produce: the day the alias moves.
  it('logs the swap when the alias is repointed mid-flight', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => response({ modelVersion: 'gemini-3.5-flash-lite' }))
      .mockImplementationOnce(async () => response({ modelVersion: 'gemini-4.0-flash-lite' }));
    vi.stubGlobal('fetch', fetchMock);

    await call();
    await call();

    expect(logs.info).toHaveBeenCalledWith(
      expect.objectContaining({
        modelVersion: 'gemini-4.0-flash-lite',
        previousModelVersion: 'gemini-3.5-flash-lite',
      }),
      'gemini resolved model version changed',
    );
  });

  it('says nothing when Google omits the field rather than logging a false swap', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({})),
    );

    await expect(call()).resolves.toMatchObject({ modelVersion: null });
    expect(logs.info).not.toHaveBeenCalled();
  });
});
