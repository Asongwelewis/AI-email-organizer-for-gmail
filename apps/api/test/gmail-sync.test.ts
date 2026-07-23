import { describe, expect, it, vi } from 'vitest';

import { withGmailRetry } from '../src/integrations/gmail/gmail.client.js';
import { classifyGmailError } from '../src/integrations/gmail/gmail.errors.js';
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

  it('does not retry missing permission', async () => {
    const classified = classifyGmailError({ response: { status: 403 } });
    expect(classified).toMatchObject({
      code: 'GMAIL_PERMISSION_DENIED',
      retryable: false,
      statusCode: 403,
    });
  });
});
