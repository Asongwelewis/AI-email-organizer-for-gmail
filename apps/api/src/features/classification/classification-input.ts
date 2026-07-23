import { createHash } from 'node:crypto';

import type { gmail_message_metadata } from '@prisma/client';
import { env } from '@api/config/env.js';
import { ClassificationError } from './classification.errors.js';
import type { ClassificationInput } from './classification.types.js';

const SUBJECT_LIMIT = 300;
const NAME_LIMIT = 120;
const SUMMARY_LIMIT = 200;
const SNIPPET_LIMIT = 700;

function bounded(value: string | null, limit: number): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function emailParts(email: string | null): { local: string; domain: string } {
  const normalized = (email ?? '').trim().toLowerCase();
  const separator = normalized.lastIndexOf('@');
  if (separator <= 0) return { local: '', domain: '' };
  return {
    local: normalized.slice(0, separator),
    domain: normalized
      .slice(separator + 1)
      .replace(/[^a-z0-9.-]/g, '')
      .slice(0, 253),
  };
}

function localPartCategory(local: string): ClassificationInput['senderLocalPartCategory'] {
  if (!local) return 'unknown';
  if (/(no-?reply|donotreply|mailer|notification|alert|updates?)/i.test(local)) return 'automated';
  if (/^(support|help|billing|sales|security|admin|team|info)$/i.test(local)) return 'role';
  return 'person-like';
}

export function normalizeClassificationInput(
  message: gmail_message_metadata,
  accountEmail?: string,
): ClassificationInput {
  const sender = emailParts(message.sender_email);
  const recipientDomain = emailParts(accountEmail ?? null).domain;
  const input: ClassificationInput = {
    subject: bounded(message.subject, SUBJECT_LIMIT),
    senderDisplayName: bounded(message.sender_name, NAME_LIMIT),
    senderDomain: sender.domain,
    senderLocalPartCategory: localPartCategory(sender.local),
    recipientRoleSummary: bounded(message.recipient_summary, SUMMARY_LIMIT).replace(
      /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi,
      '[address]@$1',
    ),
    snippet: bounded(message.snippet, SNIPPET_LIMIT).replace(
      /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi,
      '[address]@$1',
    ),
    gmailLabels: [...message.label_ids].sort().slice(0, 30),
    isUnread: message.is_unread,
    isImportant: message.is_important,
    isStarred: message.is_starred,
    hasAttachments: message.has_attachments,
    messageDate: message.internal_date?.toISOString() ?? null,
    sameDomain: Boolean(sender.domain && recipientDomain && sender.domain === recipientDomain),
  };
  if (stableStringify(input).length > env.AI_CLASSIFICATION_INPUT_MAX_CHARS) {
    throw new ClassificationError(
      'CLASSIFICATION_INPUT_TOO_LARGE',
      'The normalized message metadata exceeds the classifier input limit.',
      422,
      false,
    );
  }
  return input;
}

export function stableStringify(value: ClassificationInput): string {
  return JSON.stringify(value);
}

export function hashClassificationInput(input: ClassificationInput): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex');
}
