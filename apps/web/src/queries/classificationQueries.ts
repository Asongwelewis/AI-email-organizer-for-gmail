import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { ClassificationCategory, RecommendedAction } from '@web/types/classification';
import { api } from '@web/services/http';
import { queryKeys } from './queryKeys';

export function useClassificationStatus(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.classificationStatus,
    queryFn: api.getClassificationStatus,
    enabled,
    retry: false,
    refetchInterval: (query) => (query.state.data?.running ? 2000 : false),
  });
}

export function useClassificationResults(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: queryKeys.classificationResults,
    queryFn: ({ pageParam }) => api.getClassificationResults(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled,
    retry: false,
  });
}

export function useClassificationActions() {
  const client = useQueryClient();
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.classificationStatus }),
      client.invalidateQueries({ queryKey: queryKeys.classificationResults }),
    ]);
  };
  const run = useMutation({ mutationFn: api.runClassification, onSuccess: refresh });
  const correct = useMutation({
    mutationFn: (input: {
      id: string;
      category: ClassificationCategory;
      recommendedAction: RecommendedAction;
    }) =>
      api.correctClassification(input.id, {
        category: input.category,
        recommendedAction: input.recommendedAction,
      }),
    onSuccess: refresh,
  });
  return { run, correct };
}
