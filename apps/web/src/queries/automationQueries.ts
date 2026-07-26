import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@web/services/http';
import type { ClassificationCategory } from '@web/types/classification';
import { queryKeys } from './queryKeys';

export function useAutomationStatus() {
  return useQuery({
    queryKey: queryKeys.automationStatus,
    queryFn: api.getAutomationStatus,
    retry: false,
    refetchInterval: (query) => (query.state.data?.running ? 2000 : 30000),
  });
}

export function useAutomationReview() {
  return useQuery({
    queryKey: queryKeys.automationReview,
    queryFn: api.getAutomationReview,
    retry: false,
  });
}

export function useAutomationActions() {
  const client = useQueryClient();
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.automationStatus }),
      client.invalidateQueries({ queryKey: queryKeys.automationReview }),
      client.invalidateQueries({ queryKey: queryKeys.gmailConnection }),
    ]);
  };
  return {
    run: useMutation({ mutationFn: api.runAutomation, onSuccess: refresh }),
    approve: useMutation({
      mutationFn: (input: { id: string; category: ClassificationCategory }) =>
        api.approveAutomationReview(input.id, input.category),
      onSuccess: refresh,
    }),
    skip: useMutation({ mutationFn: api.skipAutomationReview, onSuccess: refresh }),
  };
}
