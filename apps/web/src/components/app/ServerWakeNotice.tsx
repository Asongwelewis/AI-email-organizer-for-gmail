import { useIsFetching } from '@tanstack/react-query';

import { useDelayedFlag } from '@web/lib/useDelayedFlag';

/** How long a request may run before the wait is worth explaining. */
export const SLOW_SERVER_DELAY_MS = 4_000;

export const SLOW_SERVER_MESSAGE =
  'Waking up the server. It sleeps when nobody is using it, so the first visit after a quiet spell can take up to a minute.';

/**
 * Says why the screen is still loading when the answer is "the server was asleep".
 *
 * The app now opens on what it last showed, so a person can be reading folders while the server
 * is still starting — and then tap one and wait. Without a word about why, that reads as broken.
 */
export function ServerWakeNotice() {
  const fetching = useIsFetching() > 0;
  const slow = useDelayedFlag(fetching, SLOW_SERVER_DELAY_MS);
  if (!slow) return null;
  return (
    <p className="server-wake" role="status" aria-live="polite">
      {SLOW_SERVER_MESSAGE}
    </p>
  );
}
