import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@web/services/http';
import type { ConfirmLabelInput } from '@web/types/labels';
import { queryKeys } from './queryKeys';

export function useLabels() {
  return useQuery({
    queryKey: queryKeys.labels,
    queryFn: api.getLabels,
    retry: false,
  });
}

export function useLabelActions() {
  const client = useQueryClient();
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.labels }),
      client.invalidateQueries({ queryKey: queryKeys.automationStatus }),
    ]);
  };
  return {
    propose: useMutation({ mutationFn: api.proposeLabels, onSuccess: refresh }),
    confirm: useMutation({
      mutationFn: (labels: ConfirmLabelInput[]) => api.confirmLabels(labels),
      onSuccess: refresh,
    }),
    rename: useMutation({
      mutationFn: (input: { id: string; leafName: string }) =>
        api.renameLabel(input.id, input.leafName),
      onSuccess: refresh,
    }),
    remove: useMutation({ mutationFn: (id: string) => api.deleteLabel(id), onSuccess: refresh }),
  };
}
