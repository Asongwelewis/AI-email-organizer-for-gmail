import { entityDisplayName } from './entity.js';
import { FACET_NAMES, type FacetName } from './facets.js';
import { validateLeafName } from './label-normalization.js';
import { LABEL_ROOT } from './taxonomy-planner.js';

/**
 * Pivoting facets into a folder tree.
 *
 * Facets are orthogonal, so a tree is a VIEW of them and not the thing itself: order them
 * ["entity", "intent"] and you get Netflix > Payment failed; order them ["domain", "intent",
 * "entity"] and the same mail becomes Finance > Payment failed > Netflix. Nothing is recomputed
 * from the mail to switch between them — only the ordering changes.
 *
 * Everything here is a pure function of the facet rows. That is deliberate: the tree that will be
 * written to Gmail can be built, printed, and reviewed without a single remote call.
 */

/**
 * The facets a pivot may order. Defined once, in `facets.ts`, so the vocabulary module and the
 * pivot cannot drift into disagreeing about which axes a message has.
 */
export const PIVOT_FACETS = FACET_NAMES;

export type PivotFacet = FacetName;

/** Netflix > Payment failed. The default, and the ordering materialised into Gmail. */
export const DEFAULT_PIVOT: PivotFacet[] = ['entity', 'intent'];

/** The alternate view: the same mail organised by what it is about rather than by who sent it. */
export const ALTERNATE_PIVOT: PivotFacet[] = ['domain', 'intent', 'entity'];

/** Gmail's own ceiling on nesting, and the depth the user_labels tree trigger enforces. */
export const MAX_PIVOT_DEPTH = 3;

export interface FacetedMessage {
  id: string;
  entity: string | null;
  domain: string | null;
  intent: string | null;
  /** Unread in Gmail. Absent is treated as read, so a caller that does not ask still works. */
  unread?: boolean;
  receivedAt?: Date | null;
}

export interface PivotNode {
  /** "entity=netflix|intent=payment-failed" — the folder's identity, independent of its name. */
  facetKey: string;
  parentFacetKey: string | null;
  depth: number;
  facet: PivotFacet;
  value: string;
  leafName: string;
  /** Path without the MailMind root: "Netflix/Payment failed". */
  path: string;
  fullPath: string;
  /** Messages filed into this exact folder. Never rolled up from children. */
  messageCount: number;
  /** Messages in this folder and everything beneath it. */
  subtreeMessageCount: number;
  /**
   * Unread mail, counted the same two ways.
   *
   * This is what makes a folder tile answer "is there anything new in here" without opening it,
   * and the subtree number is the one a collapsed parent needs — unread mail three levels down is
   * still unread mail you have not seen.
   */
  unreadCount: number;
  subtreeUnreadCount: number;
  isLeaf: boolean;
  latestReceivedAt: string | null;
}

export interface PivotResult {
  order: PivotFacet[];
  nodes: PivotNode[];
  /** Messages that reached no folder, with why. These stay in the inbox, exactly as NONE did. */
  unfiled: { total: number; noFacetValue: number; belowThreshold: number };
  /** Combinations that existed but were too small to become folders. */
  collapsed: number;
}

/**
 * The leaf name for a facet value: `payment-failed` becomes "Payment failed".
 *
 * Sentence case with the hyphens opened out, which is how the rest of the tree is named. Values
 * come from an approved vocabulary or from a sender domain, so unlike a model-invented name there
 * is nothing here to second-guess — only Gmail's own restrictions to respect.
 */
export function pivotLeafName(value: string, facet?: PivotFacet): string | null {
  const spaced = value.replace(/-+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!spaced) return null;
  const branded = facet === 'entity' ? entityDisplayName(value) : null;
  const cased = branded ?? spaced.charAt(0).toUpperCase() + spaced.slice(1);
  try {
    return validateLeafName(cased);
  } catch {
    // Unusable as a Gmail label — reserved, too short, or an emoji-bearing sender domain. The
    // folder is skipped and its mail stays in the inbox rather than landing somewhere arbitrary.
    return null;
  }
}

function facetValue(message: FacetedMessage, facet: PivotFacet): string | null {
  return message[facet];
}

/** "entity=netflix|intent=payment-failed" for a prefix of the ordered facet values. */
function keyOf(order: PivotFacet[], values: string[]): string {
  return values.map((value, index) => `${order[index]}=${value}`).join('|');
}

/**
 * Builds the folder tree one ordering of the facets produces.
 *
 * Collapse is the interesting part. A combination whose subtree holds fewer than `minMessages`
 * messages does not become a folder; its mail files one level up instead, and if there is no level
 * up it stays in the inbox. That is what keeps a mailbox with 327 sending brands from turning into
 * 327 folders, most holding two messages each.
 *
 * A folder that has children AND mail of its own is the awkward case, because only leaves exist in
 * Gmail — a folder cannot both contain folders and hold mail. That mail stays in the inbox and is
 * counted, rather than being pushed into an invented "Other" folder that nobody asked for.
 */
export function buildPivot(
  messages: FacetedMessage[],
  order: PivotFacet[],
  options: { minMessages: number; since?: Date | null },
): PivotResult {
  const trimmed = order.slice(0, MAX_PIVOT_DEPTH);
  const minMessages = Math.max(1, options.minMessages);
  const filteredMessages = options.since
    ? messages.filter(
        (message) =>
          message.receivedAt !== null &&
          message.receivedAt !== undefined &&
          message.receivedAt >= options.since!,
      )
    : messages;

  // The deepest prefix of the ordering each message has values for. A message with no intent still
  // has an entity, so it belongs one level up rather than nowhere.
  const tuples: Array<{ values: string[]; unread: boolean }> = [];
  const latestTupleDates = new Map<string, Date>();
  let noFacetValue = 0;
  for (const message of filteredMessages) {
    const values: string[] = [];
    for (const facet of trimmed) {
      const value = facetValue(message, facet);
      if (!value) break;
      const name = pivotLeafName(value, facet);
      if (!name) break;
      values.push(value);
    }
    if (values.length === 0) {
      noFacetValue += 1;
      continue;
    }
    tuples.push({ values, unread: message.unread === true });
    if (message.receivedAt) {
      const tupleKey = values.join('\u0000');
      const previous = latestTupleDates.get(tupleKey);
      if (!previous || message.receivedAt > previous)
        latestTupleDates.set(tupleKey, message.receivedAt);
    }
  }

  // Cumulative count for every prefix: a folder's size is its whole subtree, not just its own mail.
  const subtreeCounts = new Map<string, number>();
  const subtreeUnread = new Map<string, number>();
  for (const { values, unread } of tuples) {
    for (let depth = 1; depth <= values.length; depth += 1) {
      const key = keyOf(trimmed, values.slice(0, depth));
      subtreeCounts.set(key, (subtreeCounts.get(key) ?? 0) + 1);
      if (unread) subtreeUnread.set(key, (subtreeUnread.get(key) ?? 0) + 1);
    }
  }
  const survives = (key: string) => (subtreeCounts.get(key) ?? 0) >= minMessages;

  // Place each message at the deepest surviving prefix of its own tuple. A prefix that does not
  // survive collapses into its parent, and the placement walk is what performs that collapse.
  const ownCounts = new Map<string, number>();
  const ownUnread = new Map<string, number>();
  const latestDates = new Map<string, Date>();
  let belowThreshold = 0;
  for (const { values, unread } of tuples) {
    let placed: string | null = null;
    for (let depth = 1; depth <= values.length; depth += 1) {
      const key = keyOf(trimmed, values.slice(0, depth));
      if (!survives(key)) break;
      placed = key;
    }
    if (!placed) {
      belowThreshold += 1;
      continue;
    }
    ownCounts.set(placed, (ownCounts.get(placed) ?? 0) + 1);
    if (unread) ownUnread.set(placed, (ownUnread.get(placed) ?? 0) + 1);
    const receivedAt = latestTupleDates.get(values.join('\u0000'));
    if (receivedAt) {
      for (let depth = 1; depth <= values.length; depth += 1) {
        const key = keyOf(trimmed, values.slice(0, depth));
        const previous = latestDates.get(key);
        if (!previous || receivedAt > previous) latestDates.set(key, receivedAt);
      }
    }
  }

  const nodes = new Map<string, PivotNode>();
  for (const key of subtreeCounts.keys()) {
    if (!survives(key)) continue;
    const parts = key.split('|');
    const values = parts.map((part) => part.slice(part.indexOf('=') + 1));
    const depth = values.length;
    const facet = trimmed[depth - 1]!;
    const leafName = pivotLeafName(values[depth - 1]!, facet);
    if (!leafName) continue;
    const parentFacetKey = depth > 1 ? parts.slice(0, depth - 1).join('|') : null;
    const parentPath =
      depth > 1
        ? values.slice(0, depth - 1).map((value, index) => pivotLeafName(value, trimmed[index]!)!)
        : [];
    const path = [...parentPath, leafName].join('/');
    nodes.set(key, {
      facetKey: key,
      parentFacetKey,
      depth,
      facet,
      value: values[depth - 1]!,
      leafName,
      path,
      fullPath: `${LABEL_ROOT}/${path}`,
      messageCount: ownCounts.get(key) ?? 0,
      subtreeMessageCount: subtreeCounts.get(key) ?? 0,
      unreadCount: ownUnread.get(key) ?? 0,
      subtreeUnreadCount: subtreeUnread.get(key) ?? 0,
      isLeaf: true,
      latestReceivedAt: latestDates.get(key)?.toISOString() ?? null,
    });
  }
  for (const node of nodes.values()) {
    if (node.parentFacetKey && nodes.has(node.parentFacetKey)) {
      nodes.get(node.parentFacetKey)!.isLeaf = false;
    }
  }

  // A folder with children cannot hold mail of its own, so that mail stays in the inbox.
  let strandedOnBranches = 0;
  for (const node of nodes.values()) {
    if (node.isLeaf) continue;
    strandedOnBranches += node.messageCount;
    node.messageCount = 0;
    // Its own mail moved to the inbox, so its own unread count goes with it. The subtree number
    // is untouched: the unread mail under this branch is still under it.
    node.unreadCount = 0;
  }

  const ordered = [...nodes.values()].sort(
    (left, right) => left.depth - right.depth || left.path.localeCompare(right.path),
  );
  return {
    order: trimmed,
    nodes: ordered,
    unfiled: {
      total: noFacetValue + belowThreshold + strandedOnBranches,
      noFacetValue,
      belowThreshold: belowThreshold + strandedOnBranches,
    },
    collapsed: [...subtreeCounts.keys()].filter((key) => !survives(key)).length,
  };
}

/**
 * The folder a single message belongs to under a built pivot, or null when it stays in the inbox.
 *
 * Filing asks this per message, so it walks the message's own facets rather than searching the
 * tree: deepest surviving leaf wins, and a message whose folder turned out to be a branch has
 * nowhere to go — exactly the case `buildPivot` counted as stranded.
 */
export function pivotLeafFor(message: FacetedMessage, result: PivotResult): PivotNode | null {
  const byKey = new Map(result.nodes.map((node) => [node.facetKey, node]));
  const values: string[] = [];
  let deepest: PivotNode | null = null;
  for (const facet of result.order) {
    const value = facetValue(message, facet);
    if (!value) break;
    values.push(value);
    const node = byKey.get(keyOf(result.order, values));
    if (!node) break;
    deepest = node;
  }
  return deepest?.isLeaf ? deepest : null;
}
