import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '../src/config/env.js';
import { OpenAiAutomationProvider } from '../src/features/automation/openai-automation.provider.js';

describe('OpenAiAutomationProvider', () => {
  const originalKey = env.OPENAI_API_KEY;
  const originalRetries = env.OPENAI_MAX_RETRIES;

  beforeEach(() => {
    env.OPENAI_API_KEY = 'test-openai-key';
  });

  afterEach(() => {
    env.OPENAI_API_KEY = originalKey;
    env.OPENAI_MAX_RETRIES = originalRetries;
    vi.unstubAllGlobals();
  });

  it('uses structured Responses API output and returns usage without exposing credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    results: [
                      {
                        key: 'm1',
                        category: 'RECEIPTS',
                        confidence: 0.94,
                        explanation: 'Receipt metadata.',
                        reasonCodes: ['RECEIPT_SIGNAL'],
                      },
                    ],
                  }),
                },
              ],
            },
          ],
          usage: {
            input_tokens: 120,
            output_tokens: 30,
            input_tokens_details: { cached_tokens: 20 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new OpenAiAutomationProvider().classify([
      {
        key: 'm1',
        subject: 'Your receipt',
        sender: 'billing@example.com',
        senderDomain: 'example.com',
        snippet: 'Paid',
        isUnread: true,
        isImportant: false,
        hasAttachments: true,
      },
    ]);

    expect(result.classifications[0]).toMatchObject({
      key: 'm1',
      category: 'RECEIPTS',
      confidence: 0.94,
    });
    expect(result.usage).toEqual({ inputTokens: 120, cachedInputTokens: 20, outputTokens: 30 });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.headers).toMatchObject({ authorization: 'Bearer test-openai-key' });
    const body = JSON.parse(String(request.body));
    expect(body.store).toBe(false);
    expect(body.text.format.type).toBe('json_schema');
  });

  it('rejects mismatched response keys instead of applying a label to the wrong message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            output: [
              {
                content: [
                  {
                    type: 'output_text',
                    text: JSON.stringify({
                      results: [
                        {
                          key: 'wrong',
                          category: 'WORK',
                          confidence: 0.9,
                          explanation: 'Work.',
                          reasonCodes: [],
                        },
                      ],
                    }),
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    await expect(
      new OpenAiAutomationProvider().classify([
        {
          key: 'm1',
          subject: '',
          sender: '',
          senderDomain: 'example.com',
          snippet: '',
          isUnread: false,
          isImportant: false,
          hasAttachments: false,
        },
      ]),
    ).rejects.toMatchObject({ code: 'OPENAI_INVALID_RESPONSE' });
  });

  it('reports insufficient quota safely and does not retry a non-recoverable 429', async () => {
    env.OPENAI_MAX_RETRIES = 2;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { type: 'insufficient_quota', code: 'insufficient_quota' },
        }),
        { status: 429, headers: { 'x-request-id': 'request-safe-id' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new OpenAiAutomationProvider().classify([
        {
          key: 'm1',
          subject: '',
          sender: '',
          senderDomain: 'example.com',
          snippet: '',
          isUnread: false,
          isImportant: false,
          hasAttachments: false,
        },
      ]),
    ).rejects.toMatchObject({
      code: 'OPENAI_INSUFFICIENT_QUOTA',
      providerStatus: 429,
      providerCode: 'insufficient_quota',
      requestId: 'request-safe-id',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries transient rate limits and recovers without duplicating classifications', async () => {
    env.OPENAI_MAX_RETRIES = 1;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { type: 'rate_limit_error' } }), {
          status: 429,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: [
              {
                content: [
                  {
                    type: 'output_text',
                    text: JSON.stringify({
                      results: [
                        {
                          key: 'm1',
                          category: 'WORK',
                          confidence: 0.91,
                          explanation: 'Work metadata.',
                          reasonCodes: ['WORK_SIGNAL'],
                        },
                      ],
                    }),
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new OpenAiAutomationProvider().classify([
      {
        key: 'm1',
        subject: 'Project',
        sender: 'person@example.com',
        senderDomain: 'example.com',
        snippet: 'Update',
        isUnread: true,
        isImportant: false,
        hasAttachments: false,
      },
    ]);

    expect(result.classifications).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
