import { emailIdentity } from './label-normalization.js';

/**
 * The routing vocabulary shared by the planner (which proposes rules) and the automation executor
 * (which applies them before spending a model call).
 *
 * Deliberately not regular expressions. The values originate from an untrusted model and are
 * replayed against every incoming message, so a pattern language with catastrophic backtracking
 * would be both an injection surface and a denial-of-service one. Substring and domain matching
 * cover the real routing cases at bounded cost.
 */
export const ROUTING_RULE_KINDS = ['SENDER_ADDRESS', 'SENDER_DOMAIN', 'SUBJECT_CONTAINS'] as const;

export type RoutingRuleKind = (typeof ROUTING_RULE_KINDS)[number];

export interface RoutingRule {
  kind: RoutingRuleKind;
  value: string;
}

export interface RoutableMessage {
  subject: string | null;
  senderEmail: string | null;
}

/**
 * More specific rules win. An exact address is the narrowest thing a rule can name, so it stays
 * first. A subject phrase comes next: it selects particular mail and can hold across senders,
 * whereas a domain claims everything an organisation ever sends. Ranking the domain above the
 * phrase let one broad rule swallow the mail its own narrower siblings existed to catch —
 * "exness.com → Finance" beat "insufficient funds → Failed payments" for every message.
 */
export const RULE_PRIORITY: Record<RoutingRuleKind, number> = {
  SENDER_ADDRESS: 10,
  SUBJECT_CONTAINS: 20,
  SENDER_DOMAIN: 30,
};

const MIN_SUBJECT_PHRASE = 3;
const MAX_SUBJECT_PHRASE = 80;

/**
 * Normalizes a rule value to its stored form, or returns null when the value cannot be a rule.
 * Called on every model-produced rule before it is persisted or evaluated.
 */
export function normalizeRuleValue(kind: RoutingRuleKind, rawValue: string): string | null {
  const value = rawValue.trim().toLowerCase();
  if (!value) return null;
  if (kind === 'SENDER_ADDRESS') {
    const identity = emailIdentity(value);
    if (!identity.localPart || !identity.registrableDomain) return null;
    return value.length <= 320 ? value : null;
  }
  if (kind === 'SENDER_DOMAIN') {
    const domain = value.replace(/^@/, '');
    // Accept only a registrable domain, so a rule can never be a bare public suffix like "com".
    const identity = emailIdentity(`someone@${domain}`);
    return identity.registrableDomain && domain.length <= 253 ? domain : null;
  }
  const phrase = value.replace(/\s+/g, ' ');
  return phrase.length >= MIN_SUBJECT_PHRASE && phrase.length <= MAX_SUBJECT_PHRASE ? phrase : null;
}

export function matchesRule(rule: RoutingRule, message: RoutableMessage): boolean {
  if (rule.kind === 'SUBJECT_CONTAINS') {
    return (message.subject ?? '').toLowerCase().replace(/\s+/g, ' ').includes(rule.value);
  }
  const identity = emailIdentity(message.senderEmail);
  if (rule.kind === 'SENDER_ADDRESS') {
    return (message.senderEmail ?? '').trim().toLowerCase() === rule.value;
  }
  // A domain rule also covers its subdomains: mail.github.com routes with github.com.
  return (
    identity.registrableDomain === rule.value ||
    identity.senderDomain === rule.value ||
    identity.senderDomain.endsWith(`.${rule.value}`)
  );
}

export function countRuleMatches(rule: RoutingRule, messages: RoutableMessage[]): number {
  return messages.reduce((total, message) => total + (matchesRule(rule, message) ? 1 : 0), 0);
}

/**
 * Resolves the single rule that files a message, or null when none matches and the model has to
 * decide. Rules are sorted most-specific-first so the winner does not depend on load order.
 */
export function findMatchingRule<T extends RoutingRule>(
  rules: T[],
  message: RoutableMessage,
): T | null {
  return rules.find((rule) => matchesRule(rule, message)) ?? null;
}

export function byRuleSpecificity(left: RoutingRule, right: RoutingRule): number {
  return (
    RULE_PRIORITY[left.kind] - RULE_PRIORITY[right.kind] ||
    right.value.length - left.value.length ||
    left.value.localeCompare(right.value)
  );
}

/** A rule together with how deep in the tree the folder it files into sits. */
export interface PrecedenceRule extends RoutingRule {
  depth?: number;
}

/**
 * The order the executor resolves rules in, where each one names a folder.
 *
 * Depth decides first: a rule filing into "Finance/Transactions/Failed payments" describes its
 * mail more exactly than one filing into "Finance", whatever kind of rule either happens to be.
 * Only when two rules land at the same level does the kind break the tie.
 */
export function byRoutingPrecedence(left: PrecedenceRule, right: PrecedenceRule): number {
  return (right.depth ?? 0) - (left.depth ?? 0) || byRuleSpecificity(left, right);
}

/**
 * A rule that resolves to facet values rather than to a folder.
 *
 * Either facet may be absent: "subject contains 'insufficient funds'" says everything about intent
 * and nothing about domain, and forcing it to guess a domain would be worse than leaving the axis
 * to the model.
 */
export interface FacetRoutingRule extends RoutingRule {
  domain: string | null;
  intent: string | null;
}

export interface ResolvedFacet<T extends FacetRoutingRule> {
  value: string;
  rule: T;
}

/**
 * Resolves each facet independently, most specific rule first.
 *
 * This is the whole point of routing to facets instead of to a folder. Folder rules compete —
 * exactly one can win, so a broad "exness.com -> Finance" swallows the narrow "insufficient funds
 * -> Failed payments" it was supposed to lose to. Facet rules do not compete across axes: the
 * domain rule and the intent rule both fire, on the same message, and neither has to know the
 * other exists. A subject rule that names an intent therefore holds for every sender alive,
 * which is the generalisation a per-folder rule could never express.
 */
export function resolveFacetRules<T extends FacetRoutingRule>(
  rules: T[],
  message: RoutableMessage,
): { domain: ResolvedFacet<T> | null; intent: ResolvedFacet<T> | null } {
  let domain: ResolvedFacet<T> | null = null;
  let intent: ResolvedFacet<T> | null = null;
  // Sorted most-specific-first, so the first rule to name a facet is the one that keeps it and
  // the winner never depends on load order.
  for (const rule of [...rules].sort(byRuleSpecificity)) {
    if (domain && intent) break;
    if (!matchesRule(rule, message)) continue;
    if (!domain && rule.domain) domain = { value: rule.domain, rule };
    if (!intent && rule.intent) intent = { value: rule.intent, rule };
  }
  return { domain, intent };
}
