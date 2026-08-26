export type UserStatus = 'ACTIVE';

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  status: UserStatus;
  gmailConnected: boolean;
  tutorialCompletedAt: string | null;
}

export interface AuthMeResponse {
  user: AuthenticatedUser;
}

export interface SessionRefreshResponse {
  user: Omit<AuthenticatedUser, 'gmailConnected'>;
}

export type GoogleConnectionState =
  'CONNECTED' | 'REAUTH_REQUIRED' | 'REVOKED' | 'DISCONNECTED' | 'ERROR';

export interface GmailConnectionStatus {
  connected: boolean;
  email: string | null;
  status: GoogleConnectionState;
  grantedScopes: string[];
  requiresReauthentication: boolean;
  /** What a fresh connection would ask for — read-only unless the label export is turned on. */
  requestedGmailScope?: string;
  /** Whether this grant can write to the mailbox at all. Only `gmail.modify` can. */
  canModifyMail?: boolean;
  /**
   * A grant wider than this deployment uses. Google's grants are cumulative per client, so an
   * account connected before the read-only downgrade keeps `modify` until it is revoked.
   */
  holdsUnusedWriteScope?: boolean;
  connectedAt?: string | null;
  updatedAt?: string | null;
}

export interface ApiErrorPayload {
  error?: {
    code?: string;
    message?: string;
  };
}

export type GmailSyncState =
  | 'NOT_STARTED'
  | 'INITIAL_SYNC_RUNNING'
  | 'READY'
  | 'INCREMENTAL_SYNC_RUNNING'
  | 'LABEL_SYNC_RUNNING'
  | 'FAILED'
  | 'REAUTH_REQUIRED'
  | 'HISTORY_EXPIRED';

export interface GmailSyncStatus {
  status: GmailSyncState;
  initialSyncCompleted: boolean;
  lastSuccessfulSyncAt: string | null;
  lastErrorCode: string | null;
  nextRetryAt: string | null;
  totalGmailMessages: number;
  syncedMessages: number;
  classifiedMessages: number;
  unprocessedMessages: number;
  messageCount: number;
  syncRunning: boolean;
  backfill: {
    running: boolean;
    completed: boolean;
    messagesProcessed: number;
    totalMessages: number;
    remainingMessages: number;
    pagesCompleted: number;
    checkpointedAt: string | null;
    checkpointHistoryId: string | null;
  };
}

export interface GmailSyncResult {
  success: boolean;
  messagesExamined: number;
  messagesUpserted: number;
  messagesDeleted: number;
  labelsUpserted: number;
  checkpointHistoryId: string | null;
  syncedMessages: number;
  classifiedMessages: number;
  unprocessedMessages: number;
  messageCount: number;
}
