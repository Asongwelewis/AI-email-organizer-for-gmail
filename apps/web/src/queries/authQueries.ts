import { useMutation, useQuery } from '@tanstack/react-query';

import { api } from '@web/services/http';
import { queryKeys } from './queryKeys';

export function useAuthMeQuery() {
  return useQuery({
    queryKey: queryKeys.authMe,
    queryFn: api.getCurrentUser,
    retry: false,
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

export const useRefreshSessionMutation = () => useMutation({ mutationFn: api.refreshSession });
export const useLogoutMutation = () => useMutation({ mutationFn: api.logout });
export const useLogoutAllMutation = () => useMutation({ mutationFn: api.logoutAll });
export const useDisconnectGmailMutation = () => useMutation({ mutationFn: api.disconnectGmail });
