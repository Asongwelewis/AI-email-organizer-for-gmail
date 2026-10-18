import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import {
  useAuthMeQuery,
  useCompleteTutorialMutation,
  useDisconnectGmailMutation,
  useGmailConnectionQuery,
  useLogoutAllMutation,
  useLogoutMutation,
} from '@web/queries/authQueries';
import { unsubscribeThisBrowser } from '@web/lib/push';
import { forgetSession } from '@web/lib/sessionSnapshot';
import { queryKeys } from '@web/queries/queryKeys';
import { api, getBackendRedirectUrl, setAuthenticationFailureHandler } from '@web/services/http';
import { AuthContext, type AuthContextValue } from './useAuth';
import type { AuthMeResponse } from '@web/types/auth';

function navigateBrowser(path: string): void {
  window.location.assign(path);
}

/**
 * Stops this browser receiving the account's new-mail notifications before the session ends.
 *
 * On a shared computer the next person to sign in would otherwise keep getting the previous
 * person's mail in their notification centre. Best effort and bounded: it must never be the reason
 * a logout hangs, and the server drops dead subscriptions on its own anyway.
 */
async function releaseThisDevice(): Promise<void> {
  const release = (async () => {
    const endpoint = await unsubscribeThisBrowser();
    if (endpoint) await api.unsubscribePush(endpoint);
  })();
  const limit = new Promise<void>((resolve) => window.setTimeout(resolve, 3000));
  await Promise.race([release.catch(() => undefined), limit]);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [isRedirecting, setIsRedirecting] = useState(false);
  const authQuery = useAuthMeQuery();
  const user = authQuery.data?.user ?? null;
  const gmailQuery = useGmailConnectionQuery(Boolean(user));
  const logoutMutation = useLogoutMutation();
  const logoutAllMutation = useLogoutAllMutation();
  const disconnectMutation = useDisconnectGmailMutation();
  const tutorialMutation = useCompleteTutorialMutation();

  const clearAuthentication = useCallback(() => {
    forgetSession();
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
    await releaseThisDevice();
    await logoutMutation.mutateAsync();
    forgetSession();
    queryClient.clear();
    navigateBrowser('/login');
  }, [logoutMutation, queryClient]);

  const logoutAll = useCallback(async () => {
    await releaseThisDevice();
    await logoutAllMutation.mutateAsync();
    forgetSession();
    queryClient.clear();
    navigateBrowser('/login?status=all_sessions_ended');
  }, [logoutAllMutation, queryClient]);

  const disconnectGmail = useCallback(async () => {
    await disconnectMutation.mutateAsync();
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.gmailConnection }),
      queryClient.invalidateQueries({ queryKey: queryKeys.authMe }),
    ]);
  }, [disconnectMutation, queryClient]);

  const completeTutorial = useCallback(
    async (decision: 'COMPLETED' | 'SKIPPED') => {
      const result = await tutorialMutation.mutateAsync(decision);
      queryClient.setQueryData<AuthMeResponse>(queryKeys.authMe, (current) =>
        current
          ? {
              user: {
                ...current.user,
                tutorialCompletedAt: result.tutorialCompletedAt,
              },
            }
          : current,
      );
    },
    [queryClient, tutorialMutation],
  );

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
      isRedirecting,
      isDisconnecting: disconnectMutation.isPending,
      login: () => {
        setIsRedirecting(true);
        navigateBrowser(getBackendRedirectUrl('/auth/google'));
      },
      logout,
      logoutAll,
      connectGmail: () => {
        setIsRedirecting(true);
        navigateBrowser(getBackendRedirectUrl('/integrations/google/connect'));
      },
      disconnectGmail,
      completeTutorial,
    }),
    [
      authQuery.isLoading,
      disconnectGmail,
      disconnectMutation.isPending,
      gmailQuery.data,
      gmailQuery.isError,
      isRedirecting,
      completeTutorial,
      logout,
      logoutAll,
      user,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
