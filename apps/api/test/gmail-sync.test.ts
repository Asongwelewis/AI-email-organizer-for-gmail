import { describe, expect, it, vi } from 'vitest';

import { env } from '../src/config/env.js';
import { paceGmailUnits, withGmailRetry } from '../src/integrations/gmail/gmail.client.js';
import { classifyGmailError, parseRetryAfter } from '../src/integrations/gmail/gmail.errors.js';
import { mapGmailMessage } from '../src/integrations/gmail/gmail.mapper.js';

describe('Gmail metadata boundary', () => {
  it('maps only bounded metadata and detects nested attachments', () => {
    const mapped = mapGmailMessage({
      id: 'message-1',
      threadId: 'thread-1',
      historyId: '9876543210987654321',
      internalDate: '1720000000000',
      labelIds: ['INBOX', 'UNREAD', 'STARRED'],
      snippet: 'A safe preview',
      sizeEstimate: 1024,
      payload: {
        headers: [
          { name: 'Subject', value: '=?UTF-8?B?SGVsbG8gV29ybGQ=?=' },
          { name: 'From', value: 'Example Sender <sender@example.com>' },
          { name: 'To', value: 'recipient@example.com' },
        ],
        parts: [{ filename: 'invoice.pdf', body: { attachmentId: 'attachment-1' } }],
      },
      raw: 'must-never-be-mapped',
    });
    expect(mapped).toMatchObject({
      gmail_message_id: 'message-1',
      subject: 'Hello World',
      sender_name: 'Example Sender',
      sender_email: 'sender@example.com',
      has_attachments: true,
      is_unread: true,
      is_starred: true,
    });
    expect(JSON.stringify(mapped)).not.toContain('must-never-be-mapped');
    expect(JSON.stringify(mapped)).not.toContain('attachment-1');
  });

  // Subjects sent as windows-1252 were stored with replacement characters where their curly
  // quotes had been, because every charset but latin1 was decoded as UTF-8.
  it('decodes encoded-word subjects in the charset they name', () => {
    const subject = (value: string) =>
      mapGmailMessage({ id: 'm', payload: { headers: [{ name: 'Subject', value }] } }).subject;
    const quoted = Buffer.from([0x93, 0x53, 0x6f, 0x66, 0x74, 0x94]).toString('base64');

    expect(subject(`=?windows-1252?B?${quoted}?=`)).toBe('“Soft”');
    expect(subject('=?utf-8?Q?Caf=C3=A9_ouvert?=')).toBe('Café ouvert');
    expect(subject('=?iso-8859-1?Q?caf=E9?=')).toBe('café');
    expect(subject('=?x-unknown?Q?plain?=')).toBe('plain');
  });

  it('rejects messages without a stable Gmail id', () => {
    expect(() => mapGmailMessage({ payload: {} })).toThrow('without an id');
  });
});

describe('Gmail error and retry policy', () => {
  it('retries transient failures and then succeeds', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockResolvedValue('ok');
    const sleep = vi.fn(async () => undefined);
    await expect(withGmailRetry(operation, sleep)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  /*
   * A first sync was throttled six times in a row: three retries inside two seconds spent every
   * attempt before Gmail's per-user window had cleared. A rate limit now waits seconds, doubling.
   */
  it('backs off from a rate limit for seconds, not milliseconds, and keeps trying', async () => {
    const operation = vi.fn<() => Promise<string>>();
    for (let index = 0; index < 5; index += 1) {
      operation.mockRejectedValueOnce({ response: { status: 429 } });
    }
    operation.mockResolvedValue('ok');
    const waits: number[] = [];
    const sleep = vi.fn(async (milliseconds: number) => {
      waits.push(milliseconds);
    });

    await expect(withGmailRetry(operation, sleep)).resolves.toBe('ok');

    expect(operation).toHaveBeenCalledTimes(6);
    expect(waits[0]).toBeGreaterThanOrEqual(env.GMAIL_RATE_LIMIT_RETRY_BASE_MS);
    expect(waits[4]).toBeGreaterThanOrEqual(env.GMAIL_RATE_LIMIT_RETRY_BASE_MS * 16);
  });

  it('waits as long as Gmail asks when it says how long', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ response: { status: 429, headers: { 'retry-after': '20' } } })
      .mockResolvedValue('ok');
    const sleep = vi.fn(async () => undefined);

    await withGmailRetry(operation, sleep);

    expect(sleep).toHaveBeenCalledWith(20_000);
  });

  it('reads Retry-After as seconds or as a date', () => {
    const now = Date.parse('2026-10-24T10:00:00Z');
    expect(parseRetryAfter('7', now)).toBe(7_000);
    expect(parseRetryAfter('Sat, 24 Oct 2026 10:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter(undefined, now)).toBeNull();
  });

  // Gmail allows 250 units per user per second; a batch of 25 gets is 125 of them.
  it('holds a batch to the per-mailbox quota budget', async () => {
    const sleep = vi.fn(async () => undefined);
    const startedAt = Date.now();

    await paceGmailUnits(125, startedAt, sleep);

    const budget = (125 / env.GMAIL_SYNC_UNITS_PER_SECOND) * 1000;
    expect(sleep).toHaveBeenCalledOnce();
    const [waited] = sleep.mock.calls[0] as unknown as [number];
    expect(waited).toBeGreaterThan(budget - 100);
    expect(waited).toBeLessThanOrEqual(budget);
  });

  it('does not hold a batch that already took longer than its budget', async () => {
    const sleep = vi.fn(async () => undefined);
    await paceGmailUnits(125, Date.now() - 10_000, sleep);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry missing permission', async () => {
    const classified = classifyGmailError({ response: { status: 403 } });
    expect(classified).toMatchObject({
      code: 'GMAIL_PERMISSION_DENIED',
      retryable: false,
      statusCode: 403,
    });
  });
});
