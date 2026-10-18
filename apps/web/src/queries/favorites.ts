import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { getSafeErrorMessage } from '@web/services/errorMessages';
import { api } from '@web/services/http';
import type { PivotFacet } from '@web/types/facets';
import { queryKeys } from './queryKeys';

/**
 * The starred folders, and starring or unstarring one.
 *
 * The star fills the moment it is tapped and only goes back if the server refuses: waiting a round
 * trip on a free-plan server to see your own tap land is the kind of lag that reads as broken.
 */
export function useFavorites() {
  const queryClient = useQueryClient();
  const keysQuery = useQuery({
    queryKey: queryKeys.favoriteKeys,
    queryFn: () => api.getFavoriteKeys(),
    staleTime: 60_000,
  });
  const starred = new Set(keysQuery.data ?? []);

  const toggle = useMutation({
    mutationFn: async (input: { facetKey: string; order: PivotFacet[]; favorite: boolean }) => {
      if (input.favorite) await api.addFavorite(input.facetKey, input.order);
      else await api.removeFavorite(input.facetKey);
    },
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.favoriteKeys });
      const previous = queryClient.getQueryData<string[]>(queryKeys.favoriteKeys);
      queryClient.setQueryData<string[]>(queryKeys.favoriteKeys, (current = []) =>
        input.favorite
          ? [...new Set([...current, input.facetKey])]
          : current.filter((key) => key !== input.facetKey),
      );
      return { previous };
    },
    onError: (error, _input, context) => {
      queryClient.setQueryData(queryKeys.favoriteKeys, context?.previous);
      toast.error(getSafeErrorMessage(error, 'That folder could not be updated.'));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.favorites });
    },
  });

  return {
    isFavorite: (facetKey: string) => starred.has(facetKey),
    toggleFavorite: (facetKey: string, order: PivotFacet[]) =>
      toggle.mutate({ facetKey, order, favorite: !starred.has(facetKey) }),
  };
}
