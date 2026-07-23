import { getDomain } from 'tldts';

import {
  LABEL_CANDIDATE_TYPES,
  LABEL_NAMESPACES,
  type LabelCandidateType,
} from './label-discovery.taxonomy.js';

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
const BRAND_NAMES: Record<string, string> = {
  github: 'GitHub',
  linkedin: 'LinkedIn',
  netflix: 'Netflix',
  youtube: 'YouTube',
  paypal: 'PayPal',
  microsoft: 'Microsoft',
  google: 'Google',
};

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

export function normalizeDisplayName(value: string | null): string {
  return stripControlCharacters(value ?? '')
    .replace(/\b(?:no-?reply|notifications?|alerts?|mail(?:er)?|updates?)\b/gi, ' ')
    .replace(/\b(?:incorporated|inc|llc|ltd|limited|corp|corporation)\.?$/i, '')
    .replace(/[<>[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

export function displayNameForDomain(domain: string, observedName?: string | null): string {
  const cleaned = normalizeDisplayName(observedName ?? null);
  if (cleaned.length >= 2 && !isGenericLabelName(cleaned)) return normalizeCapitalization(cleaned);
  const base = domain.split('.')[0] ?? '';
  return BRAND_NAMES[base] ?? normalizeCapitalization(base.replace(/[-_]+/g, ' '));
}

function normalizeCapitalization(value: string): string {
  if (!value) return '';
  const brand = BRAND_NAMES[value.toLowerCase().replace(/\s+/g, '')];
  if (brand) return brand;
  if (/^[A-Z0-9]{2,8}$/.test(value)) return value;
  return value
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    .trim();
}

export function normalizeSubjectPattern(value: string | null): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/^(?:re|fw|fwd)\s*:\s*/g, '')
    .replace(/\b(?:19|20)\d{2}\b/g, '[date]')
    .replace(/\b\d{4,}\b/g, '[number]')
    .replace(/\b[a-f0-9]{8,}\b/g, '[token]')
    .replace(/[^\p{L}\p{N}\s[\]-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export function normalizeLabelForComparison(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/^mailmind\/(?:sources|organizations|topics|subscriptions|projects|workflows)\//, '')
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

export function isTemporarySubject(value: string | null): boolean {
  const subject = (value ?? '').toLowerCase();
  return /\b(?:one[- ]time|verification code|security code|password reset|black friday|cyber monday|confirm your email|temporary code|otp)\b/.test(
    subject,
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

export function buildControlledLabelPath(type: LabelCandidateType, leaf: string): string {
  if (!LABEL_CANDIDATE_TYPES.includes(type)) throw new Error('LABEL_CANDIDATE_PATH_INVALID');
  const safeLeaf = validateLeafName(leaf);
  const namespace = LABEL_NAMESPACES[type];
  const path = `MailMind/${namespace}/${safeLeaf}`;
  if (path.length > 225 || path.includes('//') || path.split('/').length !== 3) {
    throw new Error('LABEL_CANDIDATE_PATH_INVALID');
  }
  return path;
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
