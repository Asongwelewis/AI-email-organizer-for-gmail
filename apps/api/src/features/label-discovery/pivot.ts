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
  /** Only read to pick a brand folder's logo; never part of a folder's identity. */
  senderEmail?: string | null;
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
  /**
   * The domain a brand folder's logo is fetched for — the one its mail most often comes from.
   * Only on `entity` folders, and only when the view was asked to attach it.
   */
  iconDomain?: string | null;
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
 *
 * A time window (`since`) narrows what the folders SHOW, never which folders EXIST. The tree is
 * shaped by the whole mailbox and the window then picks the mail inside it. It used to be the other
 * way round: the tree was rebuilt from the window alone, so in "Last 24 hours" a brand with one new
 * message fell below `minMessages`, collapsed, and its new mail vanished from the screen instead of
 * appearing in the folder it lives in every other day. A folder with nothing in the window is left
 * out of that view, and nothing the window holds can create a folder the full mailbox would not.
 */
export function buildPivot(
  messages: FacetedMessage[],
  order: PivotFacet[],
  options: { minMessages: number; since?: Date | null },
): PivotResult {
  const trimmed = order.slice(0, MAX_PIVOT_DEPTH);
  const minMessages = Math.max(1, options.minMessages);
  const since = options.since ?? null;
  const inWindow = (message: FacetedMessage) =>
    !since ||
    (message.receivedAt !== null &&
      message.receivedAt !== undefined &&
      message.receivedAt >= since);

  // The deepest prefix of the ordering each message has values for. A message with no intent still
  // has an entity, so it belongs one level up rather than nowhere.
  interface Tuple {
    values: string[];
    unread: boolean;
    receivedAt: Date | null;
    shown: boolean;
  }
  const tuples: Tuple[] = [];
  let noFacetValue = 0;
  for (const message of messages) {
    const shown = inWindow(message);
    const values: string[] = [];
    for (const facet of trimmed) {
      const value = facetValue(message, facet);
      if (!value) break;
      const name = pivotLeafName(value, facet);
      if (!name) break;
      values.push(value);
    }
    if (values.length === 0) {
      if (shown) noFacetValue += 1;
      continue;
    }
    tuples.push({
      values,
      unread: message.unread === true,
      receivedAt: message.receivedAt ?? null,
      shown,
    });
  }

  // Which folders exist: the whole mailbox decides, whatever window is on screen.
  const structureCounts = new Map<string, number>();
  for (const { values } of tuples) {
    for (let depth = 1; depth <= values.length; depth += 1) {
      const key = keyOf(trimmed, values.slice(0, depth));
      structureCounts.set(key, (structureCounts.get(key) ?? 0) + 1);
    }
  }
  const survives = (key: string) => (structureCounts.get(key) ?? 0) >= minMessages;
  const parentOf = (key: string) => {
    const cut = key.lastIndexOf('|');
    return cut === -1 ? null : key.slice(0, cut);
  };
  // A folder with a surviving child is a branch, and a branch cannot hold mail of its own.
  const branches = new Set<string>();
  for (const key of structureCounts.keys()) {
    const parent = parentOf(key);
    if (parent && survives(key)) branches.add(parent);
  }

  // What the folders show: only the mail inside the window, counted the two usual ways.
  const subtreeCounts = new Map<string, number>();
  const subtreeUnread = new Map<string, number>();
  const ownCounts = new Map<string, number>();
  const ownUnread = new Map<string, number>();
  const latestDates = new Map<string, Date>();
  // Folders with mail of the window filed somewhere at or beneath them. Only these are shown.
  const visible = new Set<string>();
  let belowThreshold = 0;
  let strandedOnBranches = 0;
  for (const { values, unread, receivedAt, shown } of tuples) {
    if (!shown) continue;
    let placed: string | null = null;
    let walking = true;
    for (let depth = 1; depth <= values.length; depth += 1) {
      const key = keyOf(trimmed, values.slice(0, depth));
      subtreeCounts.set(key, (subtreeCounts.get(key) ?? 0) + 1);
      if (unread) subtreeUnread.set(key, (subtreeUnread.get(key) ?? 0) + 1);
      if (receivedAt) {
        const previous = latestDates.get(key);
        if (!previous || receivedAt > previous) latestDates.set(key, receivedAt);
      }
      // Placement walks down while the folders exist; a prefix that does not collapses into its
      // parent, and stopping the walk there is what performs that collapse.
      if (walking && survives(key)) placed = key;
      else walking = false;
    }
    if (!placed) {
      belowThreshold += 1;
      continue;
    }
    if (branches.has(placed)) {
      // A folder with children cannot hold mail of its own, so this stays in the inbox.
      strandedOnBranches += 1;
      continue;
    }
    ownCounts.set(placed, (ownCounts.get(placed) ?? 0) + 1);
    if (unread) ownUnread.set(placed, (ownUnread.get(placed) ?? 0) + 1);
    for (let key: string | null = placed; key; key = parentOf(key)) visible.add(key);
  }

  const nodes: PivotNode[] = [];
  for (const key of visible) {
    const parts = key.split('|');
    const values = parts.map((part) => part.slice(part.indexOf('=') + 1));
    const depth = values.length;
    const facet = trimmed[depth - 1]!;
    const leafName = pivotLeafName(values[depth - 1]!, facet);
    if (!leafName) continue;
    const path = values.map((value, index) => pivotLeafName(value, trimmed[index]!)!).join('/');
    nodes.push({
      facetKey: key,
      parentFacetKey: parentOf(key),
      depth,
      facet,
      value: values[depth - 1]!,
      leafName,
      path,
      fullPath: `${LABEL_ROOT}/${path}`,
      // A branch's own mail stayed in the inbox above, so its own counts are zero by construction.
      messageCount: ownCounts.get(key) ?? 0,
      subtreeMessageCount: subtreeCounts.get(key) ?? 0,
      unreadCount: ownUnread.get(key) ?? 0,
      // The subtree number is untouched by stranding: unread mail under a branch is still under it.
      subtreeUnreadCount: subtreeUnread.get(key) ?? 0,
      isLeaf: !branches.has(key),
      latestReceivedAt: latestDates.get(key)?.toISOString() ?? null,
    });
  }

  nodes.sort((left, right) => left.depth - right.depth || left.path.localeCompare(right.path));
  return {
    order: trimmed,
    nodes,
    unfiled: {
      total: noFacetValue + belowThreshold + strandedOnBranches,
      noFacetValue,
      belowThreshold: belowThreshold + strandedOnBranches,
    },
    collapsed: [...structureCounts.keys()].filter((key) => !survives(key)).length,
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
