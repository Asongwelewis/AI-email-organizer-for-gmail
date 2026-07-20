import { createContext, useContext } from 'react';

import type { AuthenticatedUser, GmailConnectionStatus } from '@web/types/auth';

export interface AuthContextValue {
  user: AuthenticatedUser | null;
  gmailConnection: GmailConnectionStatus | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
  isRedirecting: boolean;
  isDisconnecting: boolean;
  login: () => void;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
  refreshSession: () => Promise<void>;
  connectGmail: () => void;
  disconnectGmail: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used within AuthProvider');
  return value;
}
