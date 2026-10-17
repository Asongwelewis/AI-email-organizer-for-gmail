import { useMutation, useQuery } from '@tanstack/react-query';

import { isAxiosError } from 'axios';

import { rememberSession, rememberedSession } from '@web/lib/sessionSnapshot';
import { api } from '@web/services/http';
import { queryKeys } from './queryKeys';

/**
 * Whether a failed session check is worth asking again. A 401 or 403 is an answer; anything else —
 * a timeout, a 502 while the free-plan server is still waking — is not, and treating it as one
 * sent a signed-in person to the login screen.
 */
function retrySessionCheck(failureCount: number, error: unknown): boolean {
  const status = isAxiosError(error) ? error.response?.status : undefined;
  if (status === 401 || status === 403) return false;
  return failureCount < 3;
}

export function useAuthMeQuery() {
  return useQuery({
    queryKey: queryKeys.authMe,
    queryFn: async () => {
      const session = await api.getCurrentUser();
      rememberSession(session);
      return session;
    },
    /*
     * The app opens on the session it remembers and confirms it in the background. The server
     * still decides every request: if the session is gone, the first 401 clears this and the
     * protected screens send the person to sign in.
     */
    placeholderData: () => rememberedSession(),
    retry: retrySessionCheck,
    retryDelay: (attempt) => Math.min(2_000 * 2 ** attempt, 10_000),
    staleTime: 60_000,
  });
}

export function useGmailConnectionQuery(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.gmailConnection,
    queryFn: api.getGmailStatus,
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}

export const useLogoutMutation = () => useMutation({ mutationFn: api.logout });
export const useLogoutAllMutation = () => useMutation({ mutationFn: api.logoutAll });
export const useDisconnectGmailMutation = () => useMutation({ mutationFn: api.disconnectGmail });
export const useCompleteTutorialMutation = () => useMutation({ mutationFn: api.completeTutorial });
