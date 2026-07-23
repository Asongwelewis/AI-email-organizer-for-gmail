import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@web/services/http';
import { queryKeys } from './queryKeys';

export function useGmailSyncStatusQuery(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.gmailSyncStatus,
    queryFn: api.getGmailSyncStatus,
    enabled,
    retry: false,
    refetchInterval: (query) => (query.state.data?.syncRunning ? 2000 : false),
  });
}

export function useGmailSyncActions() {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.gmailSyncStatus });
  const labels = useMutation({ mutationFn: api.initializeGmailLabels, onSuccess: refresh });
  const initial = useMutation({ mutationFn: api.initialGmailSync, onSuccess: refresh });
  const incremental = useMutation({ mutationFn: api.incrementalGmailSync, onSuccess: refresh });
  return { labels, initial, incremental };
}
