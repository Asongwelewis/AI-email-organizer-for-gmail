import { useIsFetching } from '@tanstack/react-query';

import { useDelayedFlag } from '@web/lib/useDelayedFlag';

/** How long a request may run before the wait is worth explaining. */
export const SLOW_SERVER_DELAY_MS = 4_000;

export const SLOW_SERVER_MESSAGE =
  'Starting up. The server rests when nobody is using it, so the first visit after a quiet spell takes a few seconds.';

/**
 * True once a request has run long enough to be worth explaining — a server still waking, or a
 * dropped connection being retried. The notice above a phone's screen and the desktop island both
 * say so from this.
 */
export function useServerWaking(): boolean {
  const fetching = useIsFetching() > 0;
  return useDelayedFlag(fetching, SLOW_SERVER_DELAY_MS);
}
