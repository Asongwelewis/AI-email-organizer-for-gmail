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
    /** Sorted into folders today, by rules and by the model, whether or not Gmail was written. */
    messagesSorted?: number;
  };
  /** The watcher that sorts new mail as it arrives, between the full runs. */
  watch?: {
    /** 0 when it is turned off. */
    intervalSeconds: number;
    lastCheckedAt: string | null;
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
