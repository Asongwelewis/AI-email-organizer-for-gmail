import { SLOW_SERVER_DELAY_MS, SLOW_SERVER_MESSAGE } from '@web/components/app/ServerWakeNotice';
import { useDelayedFlag } from '@web/lib/useDelayedFlag';

export function RouteLoader({ label = 'Checking your session' }: { label?: string }) {
  // Only someone with nothing remembered — a first visit, or after signing out — waits here, and
  // on a cold start they wait the longest. Past a few seconds they are told why.
  const slow = useDelayedFlag(true, SLOW_SERVER_DELAY_MS);
  return (
    <div className="route-loader" role="status" aria-live="polite" aria-label={label}>
      <span className="route-loader__mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <p>{label}</p>
      {slow ? <p className="route-loader__hint">{SLOW_SERVER_MESSAGE}</p> : null}
    </div>
  );
}
