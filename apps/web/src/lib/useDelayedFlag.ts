import { useEffect, useState } from 'react';

/**
 * True once `active` has stayed true for `delayMs` without a break, false the moment it stops.
 *
 * For notices that are only worth showing when something is genuinely slow: a hint that flashes
 * on every ordinary request is a hint people learn to ignore.
 */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) {
      setElapsed(false);
      return;
    }
    const timer = window.setTimeout(() => setElapsed(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs]);
  return active && elapsed;
}
