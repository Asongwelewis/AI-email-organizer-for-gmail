import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { canonicalWatchKey, watchStateOf, type WatchState } from '@web/lib/watches';
import { getSafeErrorMessage } from '@web/services/errorMessages';
import { api } from '@web/services/http';
import { queryKeys } from './queryKeys';

const NO_WATCHES: string[] = [];

/**
 * The watched folders, and watching or unwatching one.
 *
 * Like the star, the eye opens the moment it is tapped and only closes again if the server refuses.
 */
export function useWatches() {
  const queryClient = useQueryClient();
  const keysQuery = useQuery({
    queryKey: queryKeys.watches,
    queryFn: () => api.getWatchKeys(),
    staleTime: 60_000,
  });
  const keys = keysQuery.data ?? NO_WATCHES;

  const toggle = useMutation({
    mutationFn: async (input: { key: string; watch: boolean }) => {
      if (input.watch) await api.addWatch(input.key);
      else await api.removeWatch(input.key);
    },
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.watches });
      const previous = queryClient.getQueryData<string[]>(queryKeys.watches);
      queryClient.setQueryData<string[]>(queryKeys.watches, (current = []) =>
        input.watch
          ? [...new Set([...current, input.key])]
          : current.filter((key) => key !== input.key),
      );
      return { previous };
    },
    onSuccess: (_data, input) => {
      if (input.watch) {
        toast.success('Watching this folder', {
          description: 'It stays at the top, and new mail in it alerts your devices.',
        });
      }
    },
    onError: (error, _input, context) => {
      queryClient.setQueryData(queryKeys.watches, context?.previous);
      toast.error(getSafeErrorMessage(error, 'That folder could not be updated.'));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.watches });
      // The feed marks watched mail, and the device switch says what it alerts about.
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
    },
  });

  return {
    watchKeys: keys,
    watchState: (facetKey: string): WatchState | null => watchStateOf(facetKey, keys),
    toggleWatch: (facetKey: string) => {
      const key = canonicalWatchKey(facetKey);
      toggle.mutate({ key, watch: !keys.includes(key) });
    },
  };
}
