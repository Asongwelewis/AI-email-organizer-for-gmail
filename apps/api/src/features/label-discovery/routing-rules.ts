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
 * More specific rules win. An exact address beats its domain, and both beat a subject phrase,
 * so "notifications@github.com → Code review" is not overridden by a broad subject rule.
 */
export const RULE_PRIORITY: Record<RoutingRuleKind, number> = {
  SENDER_ADDRESS: 10,
  SENDER_DOMAIN: 20,
  SUBJECT_CONTAINS: 30,
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
