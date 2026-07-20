import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import {
  useAuthMeQuery,
  useDisconnectGmailMutation,
  useGmailConnectionQuery,
  useLogoutAllMutation,
  useLogoutMutation,
  useRefreshSessionMutation,
} from '@web/queries/authQueries';
import { queryKeys } from '@web/queries/queryKeys';
import { getBackendRedirectUrl, setAuthenticationFailureHandler } from '@web/services/http';
import { AuthContext, type AuthContextValue } from './useAuth';

function navigateBrowser(path: string): void {
  window.location.assign(path);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [isRedirecting, setIsRedirecting] = useState(false);
  const authQuery = useAuthMeQuery();
  const user = authQuery.data?.user ?? null;
  const gmailQuery = useGmailConnectionQuery(Boolean(user));
  const refreshMutation = useRefreshSessionMutation();
  const logoutMutation = useLogoutMutation();
  const logoutAllMutation = useLogoutAllMutation();
  const disconnectMutation = useDisconnectGmailMutation();

  const clearAuthentication = useCallback(() => {
    queryClient.setQueryData(queryKeys.authMe, null);
    queryClient.removeQueries({ queryKey: queryKeys.gmailConnection });
  }, [queryClient]);

  useEffect(() => {
    setAuthenticationFailureHandler(() => {
      clearAuthentication();
    });
    return () => setAuthenticationFailureHandler(null);
  }, [clearAuthentication]);

  const logout = useCallback(async () => {
    await logoutMutation.mutateAsync();
    queryClient.clear();
    navigateBrowser('/login');
  }, [logoutMutation, queryClient]);

  const logoutAll = useCallback(async () => {
    await logoutAllMutation.mutateAsync();
    queryClient.clear();
    navigateBrowser('/login?status=all_sessions_ended');
  }, [logoutAllMutation, queryClient]);

  const refreshSession = useCallback(async () => {
    await refreshMutation.mutateAsync();
    await queryClient.invalidateQueries({ queryKey: queryKeys.authMe });
  }, [queryClient, refreshMutation]);

  const disconnectGmail = useCallback(async () => {
    await disconnectMutation.mutateAsync();
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.gmailConnection }),
      queryClient.invalidateQueries({ queryKey: queryKeys.authMe }),
    ]);
  }, [disconnectMutation, queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      gmailConnection:
        gmailQuery.data ??
        (gmailQuery.isError
          ? {
              connected: false,
              email: null,
              status: 'ERROR',
              grantedScopes: [],
              requiresReauthentication: false,
            }
          : null),
      isAuthenticated: Boolean(user),
      isLoading: authQuery.isLoading,
      isRefreshing: refreshMutation.isPending,
      isRedirecting,
      isDisconnecting: disconnectMutation.isPending,
      login: () => {
        setIsRedirecting(true);
        navigateBrowser(getBackendRedirectUrl('/auth/google'));
      },
      logout,
      logoutAll,
      refreshSession,
      connectGmail: () => {
        setIsRedirecting(true);
        navigateBrowser(getBackendRedirectUrl('/integrations/google/connect'));
      },
      disconnectGmail,
    }),
    [
      authQuery.isLoading,
      disconnectGmail,
      disconnectMutation.isPending,
      gmailQuery.data,
      gmailQuery.isError,
      isRedirecting,
      logout,
      logoutAll,
      refreshMutation.isPending,
      refreshSession,
      user,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
