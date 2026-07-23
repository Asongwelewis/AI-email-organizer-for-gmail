import type { gmail_v1 } from 'googleapis';

import type { GmailMessageRecord } from './gmail.types.js';

const truncate = (value: string | null | undefined, length: number): string | null => {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, length) : null;
};

function decodeEncodedWord(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,
    (_match, charset: string, encoding: string, encoded: string) => {
      try {
        if (encoding.toLowerCase() === 'b') {
          return Buffer.from(encoded, 'base64').toString(
            charset.toLowerCase() === 'latin1' ? 'latin1' : 'utf8',
          );
        }
        const bytes = encoded
          .replace(/_/g, ' ')
          .replace(/=([0-9a-f]{2})/gi, (_: string, hex: string) =>
            String.fromCharCode(Number.parseInt(hex, 16)),
          );
        return Buffer.from(bytes, 'latin1').toString(
          charset.toLowerCase() === 'latin1' ? 'latin1' : 'utf8',
        );
      } catch {
        return encoded;
      }
    },
  );
}

function header(message: gmail_v1.Schema$Message, name: string): string | null {
  const value = message.payload?.headers?.find(
    (candidate) => candidate.name?.toLowerCase() === name.toLowerCase(),
  )?.value;
  return value ? decodeEncodedWord(value) : null;
}

function sender(value: string | null): { name: string | null; email: string | null } {
  if (!value) return { name: null, email: null };
  const match = value.match(/^(.*?)\s*<([^<>]+)>\s*$/);
  if (!match) {
    return value.includes('@')
      ? { name: null, email: truncate(value, 320)?.toLowerCase() ?? null }
      : { name: truncate(value, 320), email: null };
  }
  return {
    name: truncate(match[1]?.replace(/^"|"$/g, ''), 320),
    email: truncate(match[2], 320)?.toLowerCase() ?? null,
  };
}

function hasAttachment(part: gmail_v1.Schema$MessagePart | undefined): boolean {
  if (!part) return false;
  if (Boolean(part.filename?.trim()) || Boolean(part.body?.attachmentId)) return true;
  return part.parts?.some(hasAttachment) ?? false;
}

export function mapGmailMessage(message: gmail_v1.Schema$Message): GmailMessageRecord {
  if (!message.id) throw new Error('Gmail returned a message without an id');
  const labels = message.labelIds ?? [];
  const from = sender(header(message, 'from'));
  const recipients = [header(message, 'to'), header(message, 'cc')].filter(Boolean).join('; ');
  const timestamp = Number(message.internalDate);
  return {
    gmail_message_id: message.id,
    gmail_thread_id: message.threadId ?? null,
    history_id: message.historyId ?? null,
    internal_date: Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp) : null,
    subject: truncate(header(message, 'subject'), 998),
    sender_name: from.name,
    sender_email: from.email,
    recipient_summary: truncate(recipients, 1000),
    snippet: truncate(message.snippet, 1000),
    label_ids: labels,
    has_attachments: hasAttachment(message.payload),
    size_estimate: message.sizeEstimate ?? null,
    is_unread: labels.includes('UNREAD'),
    is_starred: labels.includes('STARRED'),
    is_important: labels.includes('IMPORTANT'),
    is_draft: labels.includes('DRAFT'),
    is_sent: labels.includes('SENT'),
    is_trashed: labels.includes('TRASH'),
  };
}
