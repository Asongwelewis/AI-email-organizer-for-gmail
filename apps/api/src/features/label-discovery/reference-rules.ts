import { prisma } from '@api/database/prisma.js';
import { PERSONAL_MAIL_DOMAINS } from './entity.js';
import { emailIdentity } from './label-normalization.js';
import { normalizeRuleValue, type FacetRoutingRule } from './routing-rules.js';

/**
 * Routing rules that belong to no mailbox, derived from a reference mailbox whose decisions were
 * made by the model and checked, and applied to every mailbox sorted without one.
 *
 * Only what was CONSISTENT becomes a rule. A sender whose mail was split between two areas of
 * life says nothing reliable about the next message from it, and a subject phrase that meant
 * different things from different senders is not a phrase with a meaning. Personal senders —
 * anyone on a free mail provider — never become rules at all: they describe the reference
 * mailbox's owner and nobody else.
 *
 * Built by `npm run reference:build`, stored in `reference_classification_rules`, and never written
 * to the repository, which is public.
 */

export interface ReferenceRule extends FacetRoutingRule {
  sampleCount: number;
  share: number;
}

export interface ReferenceSample {
  subject: string | null;
  senderEmail: string | null;
  domain: string | null;
  intent: string | null;
}

export interface ReferenceBuildOptions {
  /** Messages a sender needs before its facets count. */
  minSenderMessages: number;
  /** Share of a sender's mail that must agree on a value. */
  minSenderShare: number;
  minPhraseMessages: number;
  /** Distinct senders a phrase must appear from, so it is a meaning and not one sender's habit. */
  minPhraseSenders: number;
  minPhraseShare: number;
  maxPhrases: number;
  /** Words that must never appear in a phrase: the reference owner's own names. */
  excludedWords: ReadonlySet<string>;
}

export const DEFAULT_REFERENCE_OPTIONS: Omit<ReferenceBuildOptions, 'excludedWords'> = {
  minSenderMessages: 3,
  minSenderShare: 0.8,
  minPhraseMessages: 5,
  minPhraseSenders: 3,
  minPhraseShare: 0.85,
  maxPhrases: 600,
};

function majority(values: Array<string | null>): { value: string; share: number } | null {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: { value: string; share: number } | null = null;
  for (const [value, count] of counts) {
    const share = count / values.length;
    if (!best || share > best.share) best = { value, share };
  }
  return best;
}

const WORD = /^[a-z][a-z'’-]*$/;

function subjectWords(subject: string | null): string[] {
  return (subject ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'’\s-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Pure: the same samples always build the same rules, which is what lets the builder be tested
 * without a database and re-run without surprises.
 */
export function buildReferenceRules(
  samples: ReferenceSample[],
  options: ReferenceBuildOptions,
): ReferenceRule[] {
  const rules: ReferenceRule[] = [];

  const bySender = new Map<string, ReferenceSample[]>();
  for (const sample of samples) {
    const site = emailIdentity(sample.senderEmail).registrableDomain;
    if (!site || PERSONAL_MAIL_DOMAINS.has(site)) continue;
    bySender.set(site, [...(bySender.get(site) ?? []), sample]);
  }
  for (const [site, mail] of bySender) {
    if (mail.length < options.minSenderMessages) continue;
    const value = normalizeRuleValue('SENDER_DOMAIN', site);
    if (!value) continue;
    const domain = majority(mail.map((sample) => sample.domain));
    const intent = majority(mail.map((sample) => sample.intent));
    const domainOk = domain && domain.share >= options.minSenderShare;
    const intentOk = intent && intent.share >= options.minSenderShare;
    if (!domainOk && !intentOk) continue;
    rules.push({
      kind: 'SENDER_DOMAIN',
      value,
      domain: domainOk ? domain.value : null,
      intent: intentOk ? intent.value : null,
      sampleCount: mail.length,
      share: Math.min(domainOk ? domain.share : 1, intentOk ? intent.share : 1),
    });
  }

  // Subject phrases of two to four contiguous words, each a plain word: no digits, no names.
  const phrases = new Map<string, { intents: Array<string | null>; senders: Set<string> }>();
  for (const sample of samples) {
    const site = emailIdentity(sample.senderEmail).registrableDomain;
    if (!site || PERSONAL_MAIL_DOMAINS.has(site)) continue;
    const words = subjectWords(sample.subject);
    const seen = new Set<string>();
    for (let width = 2; width <= 4; width += 1) {
      for (let start = 0; start + width <= words.length; start += 1) {
        const window = words.slice(start, start + width);
        if (!window.every((word) => WORD.test(word) && !options.excludedWords.has(word))) continue;
        if (window.join('').length < 8) continue;
        const phrase = window.join(' ');
        if (seen.has(phrase)) continue;
        seen.add(phrase);
        const entry = phrases.get(phrase) ?? { intents: [], senders: new Set<string>() };
        entry.intents.push(sample.intent);
        entry.senders.add(site);
        phrases.set(phrase, entry);
      }
    }
  }
  const phraseRules: ReferenceRule[] = [];
  for (const [phrase, entry] of phrases) {
    if (entry.intents.length < options.minPhraseMessages) continue;
    if (entry.senders.size < options.minPhraseSenders) continue;
    const intent = majority(entry.intents);
    if (!intent || intent.share < options.minPhraseShare) continue;
    const value = normalizeRuleValue('SUBJECT_CONTAINS', phrase);
    if (!value) continue;
    phraseRules.push({
      kind: 'SUBJECT_CONTAINS',
      value,
      domain: null,
      intent: intent.value,
      sampleCount: entry.intents.length,
      share: intent.share,
    });
  }
  phraseRules.sort((left, right) => right.sampleCount - left.sampleCount);
  return [...rules, ...phraseRules.slice(0, options.maxPhrases)];
}

const CACHE_MS = 10 * 60_000;
let cached: { rules: ReferenceRule[]; at: number } | null = null;

/** Every reference rule, read at most every ten minutes: they change only when rebuilt. */
export async function referenceRules(): Promise<ReferenceRule[]> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.rules;
  const rows = await prisma.reference_classification_rules.findMany();
  const rules = rows.map((row) => ({
    kind: row.rule_kind,
    value: row.match_value,
    domain: row.facet_domain,
    intent: row.facet_intent,
    sampleCount: row.sample_count,
    share: row.share,
  }));
  cached = { rules, at: Date.now() };
  return rules;
}

/** Test seam, and what the builder calls after writing. */
export function forgetReferenceRules(): void {
  cached = null;
}

export async function replaceReferenceRules(rules: ReferenceRule[]): Promise<number> {
  await prisma.$transaction([
    prisma.reference_classification_rules.deleteMany({}),
    prisma.reference_classification_rules.createMany({
      data: rules.map((rule) => ({
        rule_kind: rule.kind,
        match_value: rule.value,
        facet_domain: rule.domain,
        facet_intent: rule.intent,
        sample_count: rule.sampleCount,
        share: rule.share,
      })),
      skipDuplicates: true,
    }),
  ]);
  forgetReferenceRules();
  return rules.length;
}
