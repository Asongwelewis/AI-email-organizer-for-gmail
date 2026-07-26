import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '../src/config/env.js';
import { OpenAiAutomationProvider } from '../src/features/automation/openai-automation.provider.js';

describe('OpenAiAutomationProvider', () => {
  const originalKey = env.OPENAI_API_KEY;

  beforeEach(() => {
    env.OPENAI_API_KEY = 'test-openai-key';
  });

  afterEach(() => {
    env.OPENAI_API_KEY = originalKey;
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
});
