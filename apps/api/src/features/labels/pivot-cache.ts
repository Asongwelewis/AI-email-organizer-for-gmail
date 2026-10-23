import type { PivotResult } from '@api/features/label-discovery/pivot.js';

/**
 * The folder view, remembered per mailbox until its mail changes.
 *
 * The Inbox asks for its folder tree every minute while it is open, and building one is a read of
 * every classified message in the mailbox plus a pivot over them. With a two-year window that is
 * thousands of rows, and on Render's free tenth of a CPU it was measured at well over a second of
 * CPU per ask — for an answer that changes only when mail arrives or is sorted. So the answer is
 * kept, and dropped by the two things that can change it: a sync storing mail, and the classifier
 * writing decisions. A short TTL bounds how stale another instance's copy can be.
 */

const TTL_MS = 5 * 60_000;
const MAX_MAILBOXES = 200;

const views = new Map<string, Map<string, { result: PivotResult; at: number }>>();

export function cachedView(accountId: string, key: string): PivotResult | null {
  const entry = views.get(accountId)?.get(key);
  if (!entry || Date.now() - entry.at > TTL_MS) return null;
  return entry.result;
}

export function rememberView(accountId: string, key: string, result: PivotResult): void {
  if (!views.has(accountId) && views.size >= MAX_MAILBOXES) {
    const oldest = views.keys().next().value;
    if (oldest !== undefined) views.delete(oldest);
  }
  const byKey = views.get(accountId) ?? new Map();
  byKey.set(key, { result, at: Date.now() });
  views.set(accountId, byKey);
}

/** Called by whatever changes a mailbox's mail or decisions. */
export function invalidatePivotViews(accountId: string): void {
  views.delete(accountId);
}

/** Test seam. */
export function forgetPivotViews(): void {
  views.clear();
}
