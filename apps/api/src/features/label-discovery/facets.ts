/**
 * The facet vocabulary a message is classified against.
 *
 * Three orthogonal facets replace the single leaf path. A tree can only express one ordering of
 * them, which is why most of this mailbox had no leaf to go in; facets are assigned independently
 * and pivoted into folders afterwards.
 *
 *   entity  — the brand a message is from. Derived from the sender domain, never asked of a model.
 *   domain  — the area of life it belongs to. Closed vocabulary, approved by the mailbox owner.
 *   intent  — what it wants, or what happened. Closed vocabulary, approved by the mailbox owner.
 *
 * The two closed vocabularies below are the ones the mailbox owner approved on 2026-08-21 after
 * reviewing a grounded proposal. They are DATA, not a suggestion: the classifier may return only
 * these values, and every value it returns is checked against this list after parsing.
 */

/** The facets a model is asked for. `entity` is derived, so it is deliberately not here. */
export const MODEL_FACET_NAMES = ['domain', 'intent'] as const;

export type ModelFacetName = (typeof MODEL_FACET_NAMES)[number];

export const FACET_NAMES = ['entity', 'domain', 'intent'] as const;

export type FacetName = (typeof FACET_NAMES)[number];

export interface FacetVocabularyValue {
  name: string;
  /** One sentence, precise enough to route by. Sent to the model verbatim. */
  definition: string;
}

/**
 * Domains are deliberately coarse. `entity` already separates Netflix from Battle.net, so a domain
 * per brand would buy nothing and a domain per interest would fragment the tree.
 */
const DOMAIN_VALUES: FacetVocabularyValue[] = [
  {
    name: 'career',
    definition:
      'Job applications, hiring and recruiting, resumes, professional networking, and work opportunities.',
  },
  {
    name: 'development',
    definition:
      'Software engineering, code repositories, cloud infrastructure, APIs, and developer tooling.',
  },
  {
    name: 'education',
    definition: 'University admissions, scholarships, courses, transcripts, and study programmes.',
  },
  {
    name: 'social',
    definition:
      'Social media activity, direct messages, community and forum threads, and friend or follower connections.',
  },
  {
    name: 'finance',
    definition:
      'Banking, payments, invoices, receipts, card and crypto transactions, and account balances.',
  },
  {
    name: 'entertainment',
    definition:
      'Streaming, video, music, games, and leisure content of every kind, including gaming stores and launches.',
  },
  {
    name: 'shopping',
    definition:
      'Retail orders, deliveries and shipping, store accounts, and purchase history for physical or digital goods.',
  },
];

/**
 * `verification` and `welcome` are drawn to be disjoint on one question: does the message require
 * the reader to do something? An OTP does; a welcome mail does not. Their definitions were
 * redrawn by hand after a grounded proposal let "verifying a newly created account" sit in both.
 */
const INTENT_VALUES: FacetVocabularyValue[] = [
  {
    name: 'verification',
    definition:
      'An action is required of the reader to prove identity or access: a one-time code, a confirmation link, or a sign-in approval.',
  },
  {
    name: 'welcome',
    definition:
      'An account was created or onboarding has begun, and no action is required of the reader.',
  },
  {
    name: 'newsletter',
    definition:
      'A periodic or broadcast roundup: digests, blog posts, articles, release notes, or community summaries.',
  },
  {
    name: 'promotional',
    definition:
      'Advertising: sales, discounts, limited-time offers, coupons, upgrade incentives, or event tickets.',
  },
  {
    name: 'application-received',
    definition:
      'An acknowledgment that something the reader submitted has been received, with no decision yet.',
  },
  {
    name: 'application-outcome',
    definition:
      'A response to something the reader submitted: a rejection, an interview invitation, an offer, or an admission decision.',
  },
  {
    name: 'job-match',
    definition:
      'An alert about job openings, headhunter recommendations, or opportunities matched to the reader.',
  },
  {
    name: 'security-alert',
    definition:
      'A security incident, unusual or new sign-in, leaked credential, or password change notification.',
  },
  {
    name: 'system-notification',
    definition:
      'An operational notice about a service: updates, downtime, paused projects, build or deployment failures, and configuration changes.',
  },
  {
    name: 'invoice-receipt',
    definition:
      'A receipt, order confirmation, invoice, or billing statement for a payment that succeeded.',
  },
  {
    name: 'payment-failed',
    definition:
      'A payment did not go through: a declined charge, insufficient funds, an expired subscription, or an account on hold.',
  },
  {
    name: 'webinar-event',
    definition:
      'An invitation or reminder for a webinar, workshop, open day, live conference, or scheduled session.',
  },
  {
    name: 'survey-feedback',
    definition: 'A request for the reader’s feedback, review, rating, or survey response.',
  },
];

export const APPROVED_FACET_VOCABULARY: Record<ModelFacetName, FacetVocabularyValue[]> = {
  domain: DOMAIN_VALUES,
  intent: INTENT_VALUES,
};

/**
 * A cross-cutting rule the mailbox owner set when approving the vocabulary: the two facets are
 * independent, so a newsletter about shoes is `shopping` + `newsletter`, not `shopping` alone and
 * not a `marketing` domain. Stated once here and sent with every prompt that carries the
 * vocabulary, so the rule and the values never drift apart.
 */
export const FACET_INDEPENDENCE_RULE =
  'The two facets are independent and are chosen separately. A newsletter keeps the domain of ' +
  'its subject matter and carries intent "newsletter"; it does not all become one domain. Every ' +
  'combination of a domain and an intent must be meaningful on its own.';

export function facetValueNames(facet: ModelFacetName): string[] {
  return APPROVED_FACET_VOCABULARY[facet].map((value) => value.name);
}

const VALUE_INDEX: Record<ModelFacetName, Map<string, FacetVocabularyValue>> = {
  domain: new Map(DOMAIN_VALUES.map((value) => [value.name, value])),
  intent: new Map(INTENT_VALUES.map((value) => [value.name, value])),
};

/** True when `name` is a value of the approved vocabulary for that facet. Case-sensitive. */
export function isApprovedFacetValue(facet: ModelFacetName, name: string): boolean {
  return VALUE_INDEX[facet].has(name);
}
