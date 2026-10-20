import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@web/services/http';
import type { OnboardingStatus } from '@web/types/onboarding';
import { queryKeys } from './queryKeys';

/** While folders are being filled, how often the open folder view is asked to catch up. */
const FOLDER_REFRESH_MS = 8_000;

function pollInterval(status: OnboardingStatus | undefined): number | false {
  if (!status || status.state === 'DONE') return false;
  // Moving: every two seconds, so the bar moves with it. Stopped: the server retries on its own
  // within five minutes, and this only needs to notice when it does.
  return status.state === 'RUNNING' || status.state === 'PENDING' ? 2_000 : 30_000;
}

/**
 * A new mailbox's first setup: its status, polled while it runs, and started if nothing has
 * started it yet.
 *
 * The server starts it the moment Gmail is connected, so the start here is a safety net — for a
 * mailbox connected before onboarding existed, or a callback whose start was lost. It is asked for
 * once per screen, and the server answers a repeat by joining the run already going.
 *
 * While mail is being sorted, the folder view is refreshed every few seconds so folders appear as
 * they fill rather than all at once at the end, and once more when setup finishes.
 */
export function useOnboarding(enabled = true) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.onboarding,
    queryFn: () => api.getOnboarding(),
    enabled,
    refetchInterval: (current) => pollInterval(current.state.data),
  });

  const start = useMutation({
    mutationFn: () => api.startOnboarding(),
    onSuccess: (status) => queryClient.setQueryData(queryKeys.onboarding, status),
  });

  const status = query.data;
  const askedToStart = useRef(false);
  useEffect(() => {
    if (status?.state !== 'PENDING' || askedToStart.current) return;
    askedToStart.current = true;
    start.mutate();
  }, [status?.state, start]);

  const lastRefresh = useRef(0);
  const previousState = useRef<OnboardingStatus['state'] | undefined>(undefined);
  useEffect(() => {
    if (!status) return;
    const finished =
      status.state === 'DONE' &&
      previousState.current !== undefined &&
      previousState.current !== 'DONE';
    const sorting = status.state === 'RUNNING' && status.stage === 'SORTING';
    previousState.current = status.state;
    const now = Date.now();
    if (finished || (sorting && now - lastRefresh.current >= FOLDER_REFRESH_MS)) {
      lastRefresh.current = now;
      void queryClient.invalidateQueries({ queryKey: ['facets'] });
      if (finished) void queryClient.invalidateQueries({ queryKey: queryKeys.automationStatus });
    }
  }, [status, queryClient]);

  return {
    status,
    isPending: query.isPending,
    error: query.error,
    retry: () => start.mutate(),
    retrying: start.isPending,
  };
}
