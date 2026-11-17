import { entityFor } from '@api/features/label-discovery/entity.js';
import {
  parseFacetKey,
  PIVOT_FACETS,
  type PivotFacet,
} from '@api/features/label-discovery/pivot.js';

/**
 * What a watch is, and which mail it covers. Pure, so the notifier and the service agree on it.
 *
 * A watch is a facet combination — `entity=applyboard`, or `entity=applyboard|intent=offer` — and it
 * covers a message when the message carries every value the watch names. Nothing about the
 * arrangement it was set from survives into the stored key: the same mail is in that folder
 * whichever way the Inbox is arranged, so the key is rewritten in one canonical facet order.
 */

export type WatchConditions = Partial<Record<PivotFacet, string>>;

export interface Watch {
  /** The canonical key, as stored. */
  facetKey: string;
  conditions: WatchConditions;
  /** How the folder reads to a person: "ApplyBoard", or "ApplyBoard › Offer". */
  name: string;
}

/** The facets of one message, as far as they are known. */
export interface MessageFacets {
  entity: string | null;
  domain: string | null;
  intent: string | null;
}

/**
 * The key in canonical facet order, or null when it is not a folder any arrangement could have.
 * Canonical order is `PIVOT_FACETS`, so a key built from `intent` first and one built from `entity`
 * first name the same watch.
 */
export function describeWatch(facetKey: string): Watch | null {
  const parts = parseFacetKey(facetKey);
  if (!parts || parts.length === 0) return null;
  const byFacet = new Map(parts.map((part) => [part.facet, part]));
  const ordered = PIVOT_FACETS.flatMap((facet) => {
    const part = byFacet.get(facet);
    return part ? [part] : [];
  });
  const conditions: WatchConditions = {};
  for (const part of ordered) conditions[part.facet] = part.value;
  return {
    facetKey: ordered.map((part) => `${part.facet}=${part.value}`).join('|'),
    conditions,
    // Named in the order it was set from, which is the order the person saw it in.
    name: parts.map((part) => part.name).join(' › '),
  };
}

/**
 * Whether a message is in the watched folder. A value the message does not carry yet — an intent
 * Gemini has not decided — is not a match, and is asked again once it has been decided.
 */
export function watchCovers(watch: Watch, facets: MessageFacets): boolean {
  return (Object.entries(watch.conditions) as Array<[PivotFacet, string]>).every(
    ([facet, value]) => facets[facet] === value,
  );
}

/**
 * A message's facets as far as they can be known right now. The entity is derived from the sender
 * in code, never asked of a model, so it is known the moment the message is stored — which is what
 * lets a watch on a brand alert before the message has been classified at all.
 */
export function knownFacets(
  senderEmail: string | null,
  decided: MessageFacets | null,
): MessageFacets {
  return {
    entity: decided?.entity ?? entityFor(senderEmail),
    domain: decided?.domain ?? null,
    intent: decided?.intent ?? null,
  };
}

/** The first watch that covers a message, or null. */
export function watchFor(watches: Watch[], facets: MessageFacets): Watch | null {
  return watches.find((watch) => watchCovers(watch, facets)) ?? null;
}
