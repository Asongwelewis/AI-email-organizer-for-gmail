export const classificationCategories = [
  'PRIMARY',
  'WORK',
  'FINANCE',
  'RECEIPTS',
  'ORDERS',
  'TRAVEL',
  'EDUCATION',
  'NEWSLETTERS',
  'PROMOTIONS',
  'SOCIAL',
  'NOTIFICATIONS',
  'SECURITY',
  'SUPPORT',
  'PERSONAL',
  'SPAM_SUSPECTED',
  'OTHER',
] as const;

export const recommendedActions = [
  'KEEP_IN_INBOX',
  'ARCHIVE_RECOMMENDED',
  'REVIEW_REQUIRED',
  'IMPORTANT_RECOMMENDED',
  'MUTE_RECOMMENDED',
  'UNSUBSCRIBE_CANDIDATE',
] as const;

export type ClassificationCategory = (typeof classificationCategories)[number];
export type RecommendedAction = (typeof recommendedActions)[number];

export interface ClassificationStatus {
  enabled: boolean;
  provider: string;
  model: string | null;
  running: boolean;
  classifiedCount: number;
  reviewRequiredCount: number;
  lastClassifiedAt: string | null;
  lastErrorCode: string | null;
  latestRun: {
    id: string;
    status: 'RUNNING' | 'COMPLETED' | 'FAILED';
    requestedMessageCount: number;
    processedMessageCount: number;
    reusedResultCount: number;
    ruleClassifiedCount: number;
    aiClassifiedCount: number;
    reviewRequiredCount: number;
    failedCount: number;
  } | null;
  categoryDistribution: Partial<Record<ClassificationCategory, number>>;
  recommendationDistribution: Partial<Record<RecommendedAction, number>>;
  versions: { classifier: string; prompt: string; taxonomy: string };
}

export interface ClassificationResult {
  id: string;
  messageId: string;
  message: {
    subject: string | null;
    sender: string;
    senderDomain: string | null;
    snippet: string | null;
    gmailLabels: string[];
    date: string | null;
  };
  recommendedCategory: ClassificationCategory;
  suggestedAction: RecommendedAction;
  confidence: number;
  requiresReview: boolean;
  explanation: string;
  reasonCodes: string[];
  source: 'RULE' | 'AI' | 'HYBRID' | 'USER';
  status: string;
  classifiedAt: string;
  correction: {
    id: string;
    correctedCategory: ClassificationCategory;
    correctedRecommendedAction: RecommendedAction;
    feedbackReason: string | null;
    createdAt: string;
  } | null;
}

export interface ClassificationResultsPage {
  results: ClassificationResult[];
  nextCursor: string | null;
}
