export const LABEL_DISCOVERY_VERSION = 'mailmind-label-discovery-v1';
export const LABEL_NAMING_VERSION = 'mailmind-label-naming-v1';
export const LABEL_CONFIDENCE_VERSION = 'mailmind-label-confidence-v1';

export const LABEL_CANDIDATE_TYPES = [
  'SOURCE',
  'ORGANIZATION',
  'TOPIC',
  'SUBSCRIPTION',
  'PROJECT',
  'WORKFLOW',
] as const;

export const LABEL_NAMESPACES = {
  SOURCE: 'Sources',
  ORGANIZATION: 'Organizations',
  TOPIC: 'Topics',
  SUBSCRIPTION: 'Subscriptions',
  PROJECT: 'Projects',
  WORKFLOW: 'Workflows',
} as const;

export const LABEL_REASON_CODES = [
  'SOURCE_VOLUME',
  'SOURCE_RECENCY',
  'DOMAIN_CONSISTENCY',
  'DISPLAY_NAME_CONSISTENCY',
  'CATEGORY_AGREEMENT',
  'SUBJECT_PATTERN_AGREEMENT',
  'THREAD_DIVERSITY',
  'EXISTING_GMAIL_CATEGORY',
  'USER_CORRECTION_SUPPORT',
  'EXISTING_LABEL_SIMILARITY',
  'TEMPORARY_EVENT_PENALTY',
  'GENERIC_NAME_PENALTY',
] as const;

/**
 * Category agreement and user-correction support were retired with the fixed
 * classification taxonomy; both were permanently zero and capped every candidate at 0.80.
 * Their combined 0.20 went to the two signals that actually separate a good candidate
 * from a bad one: message volume, which is the only signal with real spread across
 * sender candidates, and source consistency, which discounts groupings scattered across
 * unrelated senders.
 */
export const LABEL_CONFIDENCE_WEIGHTS = {
  sourceConsistency: 0.35,
  messageVolume: 0.35,
  recency: 0.1,
  threadDiversity: 0.1,
  namingConfidence: 0.1,
} as const;

export const LABEL_CANDIDATE_ACTIVE_STATUSES = ['PENDING', 'APPROVED', 'DEFERRED'] as const;

export type LabelCandidateType = (typeof LABEL_CANDIDATE_TYPES)[number];
export type LabelReasonCode = (typeof LABEL_REASON_CODES)[number];
