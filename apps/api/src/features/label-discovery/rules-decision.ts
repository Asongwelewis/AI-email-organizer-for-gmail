import {
  brandDomain,
  fallbackIntent,
  guessedDomain,
  keywordIntent,
  type HeuristicMessage,
} from './heuristics.js';
import { resolveFacetRules, type FacetRoutingRule } from './routing-rules.js';

/**
 * How one message is sorted without a model, facet by facet, first answer wins.
 *
 * The order is the point. A reference rule was learned from one person's mailbox, and what is true
 * of a sender there is not always true for everybody: amazon.com sent that mailbox AWS webinars,
 * and sends most people their orders. So anything that is true for EVERYONE goes first —
 *
 *   area of life: the mailbox's own rules → a well-known brand → a reference rule → words in the
 *                 sender's host or the subject → the Social tab;
 *   intent:       the mailbox's own rules → what the subject says outright → a reference rule →
 *                 what the sender usually sends → the Gmail tab.
 *
 * Pure, so the classifier and the accuracy measurements run the same decision.
 */

export interface DecisionRule extends FacetRoutingRule {
  confidence: number;
}

export interface FacetChoice {
  value: string | null;
  confidence: number;
  /** Whether a routing rule (the mailbox's own or a reference one) made it. */
  fromRule: boolean;
}

export interface RulesDecision {
  domain: FacetChoice;
  intent: FacetChoice;
  source: 'RULE' | 'HEURISTIC';
}

/** What a heuristic decision is worth beside a rule's measured confidence. */
export const HEURISTIC_CONFIDENCE = 0.6;

const NONE: FacetChoice = { value: null, confidence: 0, fromRule: false };

export function decideWithoutModel(
  message: HeuristicMessage,
  own: DecisionRule[],
  reference: DecisionRule[],
  approved: { domain: ReadonlySet<string>; intent: ReadonlySet<string> },
): RulesDecision {
  const routable = { subject: message.subject, senderEmail: message.senderEmail };
  const mine = resolveFacetRules(own, routable);
  const borrowed = resolveFacetRules(reference, routable);

  const pick = (axis: 'domain' | 'intent', layers: Array<() => FacetChoice | null>) => {
    for (const layer of layers) {
      const choice = layer();
      if (choice?.value && approved[axis].has(choice.value)) return choice;
    }
    return NONE;
  };
  const rule = (hit: (typeof mine)['domain']) => () =>
    hit ? { value: hit.value, confidence: hit.rule.confidence, fromRule: true } : null;
  const guess = (value: string | null) => () =>
    value ? { value, confidence: HEURISTIC_CONFIDENCE, fromRule: false } : null;

  const domain = pick('domain', [
    rule(mine.domain),
    () => guess(brandDomain(message))(),
    rule(borrowed.domain),
    () => guess(guessedDomain(message))(),
  ]);
  const intent = pick('intent', [
    rule(mine.intent),
    () => guess(keywordIntent(message))(),
    rule(borrowed.intent),
    () => guess(fallbackIntent(message))(),
  ]);
  return {
    domain,
    intent,
    source: domain.fromRule || intent.fromRule ? 'RULE' : 'HEURISTIC',
  };
}
