import { SLOW_SERVER_MESSAGE, useServerWaking } from '@web/lib/serverWaking';

/**
 * Says why the screen is still loading when the server is slow to answer — a new version still
 * starting, or a dropped connection being retried.
 *
 * The app opens on what it last showed, so a person can be reading folders while the server is
 * still starting — and then tap one and wait. Without a word about why, that reads as broken.
 */
export function ServerWakeNotice() {
  const slow = useServerWaking();
  if (!slow) return null;
  return (
    <p className="server-wake" role="status" aria-live="polite">
      {SLOW_SERVER_MESSAGE}
    </p>
  );
}
