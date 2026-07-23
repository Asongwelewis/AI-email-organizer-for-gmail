import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@web/services/http';
import { queryKeys } from './queryKeys';

export function useLabelDiscoveryStatus(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.labelDiscoveryStatus,
    queryFn: api.getLabelDiscoveryStatus,
    enabled,
    retry: false,
    refetchInterval: (query) => (query.state.data?.running ? 2000 : false),
  });
}

export function useLabelCandidates(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: queryKeys.labelCandidates,
    queryFn: ({ pageParam }) => api.getLabelCandidates(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled,
    retry: false,
  });
}

export function useLabelDiscoveryActions() {
  const client = useQueryClient();
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.labelDiscoveryStatus }),
      client.invalidateQueries({ queryKey: queryKeys.labelCandidates }),
    ]);
  };
  return {
    run: useMutation({ mutationFn: api.runLabelDiscovery, onSuccess: refresh }),
    approve: useMutation({
      mutationFn: (input: { id: string; leafName?: string }) =>
        api.approveLabelCandidate(input.id, input.leafName),
      onSuccess: refresh,
    }),
    reject: useMutation({
      mutationFn: api.rejectLabelCandidate,
      onSuccess: refresh,
    }),
    defer: useMutation({
      mutationFn: api.deferLabelCandidate,
      onSuccess: refresh,
    }),
    merge: useMutation({
      mutationFn: (input: { id: string; targetCandidateId: string }) =>
        api.mergeLabelCandidate(input.id, input.targetCandidateId),
      onSuccess: refresh,
    }),
  };
}
