export type UserStatus = 'ACTIVE';

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  status: UserStatus;
  gmailConnected: boolean;
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
  messageCount: number;
  syncRunning: boolean;
}

export interface GmailSyncResult {
  success: boolean;
  messagesExamined: number;
  messagesUpserted: number;
  messagesDeleted: number;
  labelsUpserted: number;
  checkpointHistoryId: string | null;
  messageCount: number;
}
