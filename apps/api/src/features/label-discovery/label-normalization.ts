import { getDomain } from 'tldts';

const AUTOMATED_LOCAL_PARTS = new Set([
  'no-reply',
  'noreply',
  'notifications',
  'notification',
  'alerts',
  'support',
  'info',
  'mail',
  'team',
  'news',
  'newsletter',
  'updates',
  'account',
  'service',
]);
const RESERVED_GMAIL_NAMES = new Set([
  'INBOX',
  'SPAM',
  'TRASH',
  'UNREAD',
  'STARRED',
  'IMPORTANT',
  'SENT',
  'DRAFT',
  'CHAT',
  'CATEGORY_PERSONAL',
  'CATEGORY_SOCIAL',
  'CATEGORY_PROMOTIONS',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
]);
const GENERIC_NAMES = new Set([
  'email',
  'emails',
  'notification',
  'notifications',
  'update',
  'updates',
  'message',
  'messages',
  'no reply',
  'noreply',
  'various',
  'other stuff',
]);
export function emailIdentity(email: string | null): {
  localPart: string;
  senderDomain: string;
  registrableDomain: string;
  automated: boolean;
} {
  const normalized = (email ?? '').trim().toLowerCase();
  const separator = normalized.lastIndexOf('@');
  if (separator <= 0) {
    return { localPart: '', senderDomain: '', registrableDomain: '', automated: false };
  }
  const localPart = normalized.slice(0, separator).replace(/\+.*/, '');
  const senderDomain = normalized
    .slice(separator + 1)
    .replace(/[^a-z0-9.-]/g, '')
    .replace(/^\.+|\.+$/g, '');
  const registrableDomain =
    getDomain(senderDomain, { allowPrivateDomains: true, detectIp: true }) ?? '';
  const localBase = localPart.replace(/[._+]/g, '-').replace(/\d+$/g, '');
  return {
    localPart,
    senderDomain,
    registrableDomain,
    automated:
      AUTOMATED_LOCAL_PARTS.has(localBase) ||
      /^(?:no-?reply|notifications?|alerts?|updates?)(?:[-._].*)?$/.test(localBase),
  };
}

/** Compares label names for duplicates: case, accents, and punctuation are noise. */
export function normalizeLabelForComparison(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/^mailmind\//, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, 80);
}

export function isGenericLabelName(value: string): boolean {
  return GENERIC_NAMES.has(
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim(),
  );
}

export function validateLeafName(value: string): string {
  const name = value.replace(/\s+/g, ' ').trim();
  if (
    name.length < 2 ||
    name.length > 60 ||
    stripControlCharacters(name) !== name ||
    /[/\\]/.test(name) ||
    /\p{Extended_Pictographic}/u.test(name) ||
    RESERVED_GMAIL_NAMES.has(name.toUpperCase()) ||
    isGenericLabelName(name)
  ) {
    throw new Error('LABEL_CANDIDATE_NAME_INVALID');
  }
  return name;
}

function stripControlCharacters(value: string): string {
  return [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join('');
}

export function labelsAreSimilar(left: string, right: string): boolean {
  const a = normalizeLabelForComparison(left);
  const b = normalizeLabelForComparison(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5) return false;
  return levenshtein(a, b) / Math.max(a.length, b.length) <= 0.15;
}

function levenshtein(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = row[j]!;
      row[j] = Math.min(
        row[j]! + 1,
        row[j - 1]! + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return row[right.length]!;
}
