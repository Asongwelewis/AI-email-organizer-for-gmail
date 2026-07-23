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

export const LABEL_CONFIDENCE_WEIGHTS = {
  sourceConsistency: 0.3,
  messageVolume: 0.2,
  categoryAgreement: 0.15,
  recency: 0.1,
  threadDiversity: 0.1,
  namingConfidence: 0.1,
  userCorrectionSupport: 0.05,
} as const;

export const LABEL_CANDIDATE_ACTIVE_STATUSES = ['PENDING', 'APPROVED', 'DEFERRED'] as const;

export type LabelCandidateType = (typeof LABEL_CANDIDATE_TYPES)[number];
export type LabelReasonCode = (typeof LABEL_REASON_CODES)[number];
