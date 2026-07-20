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
