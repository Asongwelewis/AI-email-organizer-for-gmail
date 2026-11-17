/**
 * Which folders a watch puts first. Pure, so the Inbox's ordering can be tested without a screen.
 *
 * A watch is a facet combination — `entity=applyboard`, or `entity=applyboard|intent=offer` — kept
 * by the server in one canonical order. A folder is a facet combination too, in whatever order its
 * arrangement uses, so the comparison is between sets of `facet=value` conditions, never strings:
 *
 * - **watched** — this folder is the watch.
 * - **covered** — a broader watch holds all of this folder's mail (ApplyBoard › Offer, when
 *   ApplyBoard is watched). Its eye is on, but it is the broader folder's eye.
 * - **leads** — this folder is on the way to a narrower watch (ApplyBoard, when only ApplyBoard ›
 *   Offer is watched), so it comes first too: otherwise the watch is behind "Show all".
 */

export type WatchState = 'watched' | 'covered' | 'leads';

const FACET_ORDER = ['entity', 'domain', 'intent'] as const;

/** `facet=value` conditions of a key. Anything malformed is simply not a condition. */
function conditionsOf(facetKey: string): Map<string, string> {
  const conditions = new Map<string, string>();
  for (const part of facetKey.split('|')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const value = part.slice(separator + 1);
    if (value) conditions.set(part.slice(0, separator), value);
  }
  return conditions;
}

/** The key the server stores for a watch on this folder: its conditions in canonical order. */
export function canonicalWatchKey(facetKey: string): string {
  const conditions = conditionsOf(facetKey);
  return FACET_ORDER.filter((facet) => conditions.has(facet))
    .map((facet) => `${facet}=${conditions.get(facet)}`)
    .join('|');
}

/** Whether every condition in `inner` is also in `outer`. */
function within(inner: Map<string, string>, outer: Map<string, string>): boolean {
  for (const [facet, value] of inner) if (outer.get(facet) !== value) return false;
  return true;
}

/** How the watches touch one folder, or null when they do not. */
export function watchStateOf(facetKey: string, watchKeys: readonly string[]): WatchState | null {
  if (watchKeys.length === 0) return null;
  const folder = conditionsOf(facetKey);
  let state: WatchState | null = null;
  for (const key of watchKeys) {
    const watch = conditionsOf(key);
    if (watch.size === 0) continue;
    const watchInFolder = within(watch, folder);
    const folderInWatch = within(folder, watch);
    if (watchInFolder && folderInWatch) return 'watched';
    if (watchInFolder) state = 'covered';
    else if (folderInWatch && state === null) state = 'leads';
  }
  return state;
}

/**
 * One level of folders with the watched ones — and the ones leading to a watch — moved to the
 * front, otherwise in the order given. `pinned` is how many were moved, so a caller can keep them
 * all in view however many folders it shows before "Show all".
 */
export function watchedFirst<T extends { facetKey: string }>(
  nodes: T[],
  watchKeys: readonly string[],
): { ordered: T[]; pinned: number } {
  if (watchKeys.length === 0) return { ordered: nodes, pinned: 0 };
  const first: T[] = [];
  const rest: T[] = [];
  for (const node of nodes) (watchStateOf(node.facetKey, watchKeys) ? first : rest).push(node);
  return { ordered: [...first, ...rest], pinned: first.length };
}
