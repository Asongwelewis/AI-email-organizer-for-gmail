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

export type ClassificationCategory = (typeof classificationCategories)[number];

export interface AutomationRun {
  id: string;
  status: 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';
  trigger: 'SCHEDULED' | 'MANUAL';
  messagesSeen: number;
  patternReused: number;
  openaiClassified: number;
  reviewRequired: number;
  messagesLabeled: number;
  failed: number;
  providerCalls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  estimatedCostMicrousd: number;
  stoppedReason: string | null;
  lastErrorCode: string | null;
  lastProviderStatus: number | null;
  lastProviderCode: string | null;
  lastProviderRequestId: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface AutomationStatus {
  gmailConnected: boolean;
  requiresReauthentication: boolean;
  enabled: boolean;
  running: boolean;
  nextRunAt: string | null;
  retryAt?: string | null;
  lastErrorCode?: string | null;
  lastRun: AutomationRun | null;
  usageToday: {
    providerCalls: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    estimatedCostMicrousd: number;
    messagesLabeled: number;
  };
  limits?: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostMicrousd: number;
    messages: number;
  };
  pendingReviewCount: number;
}

export interface AutomationReviewItem {
  id: string;
  category: ClassificationCategory;
  labelPath: string;
  confidence: number;
  explanation: string;
  reasonCodes: string[];
  createdAt: string;
  message: {
    subject: string;
    senderName: string | null;
    senderEmail: string | null;
    snippet: string | null;
    receivedAt: string | null;
  };
}

export interface AutomationReviewQueue {
  items: AutomationReviewItem[];
}
