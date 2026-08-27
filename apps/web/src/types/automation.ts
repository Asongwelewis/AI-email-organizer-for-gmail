export interface AutomationRun {
  id: string;
  status: 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';
  trigger: 'SCHEDULED' | 'MANUAL';
  messagesSeen: number;
  patternReused: number;
  aiClassified: number;
  reviewRequired: number;
  noLabelSkipped: number;
  backlogRemaining: number;
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
  /** Which of the three switches is off, so the screen can name the right one. */
  disabledReason?: 'AUTOMATION_DISABLED' | 'AUTOMATION_NOT_CONFIGURED' | 'ACCOUNT_PAUSED' | null;
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
  approvedLabelCount: number;
  labelsReady: boolean;
  backlogRemaining: number;
}

export interface AutomationReviewItem {
  id: string;
  labelName: string;
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
