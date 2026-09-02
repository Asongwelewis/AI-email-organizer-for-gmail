/**
 * A message carries three orthogonal facets, and a folder tree is a **view** of them. `entity` is
 * the sending brand, derived in code; `domain` and `intent` come from two closed vocabularies.
 */
export type PivotFacet = 'entity' | 'domain' | 'intent';
export {
  DEFAULT_EMAIL_TIME_RANGE,
  EMAIL_TIME_RANGE_LABELS,
  EMAIL_TIME_RANGES,
  isEmailTimeRange,
} from '@mailmind/shared';
export type { EmailTimeRange } from '@mailmind/shared';

export const PIVOT_FACETS: readonly PivotFacet[] = ['entity', 'domain', 'intent'];

/** How each facet reads to a person, so the screen never shows a column name. */
export const FACET_LABELS: Record<PivotFacet, string> = {
  entity: 'Brand',
  domain: 'Subject area',
  intent: 'What it wants',
};

/**
 * The orderings offered side by side.
 *
 * Facets are orthogonal, so every one of these is the same mail — no reclassification, no Gmail
 * call, nothing to apply. They stopped being a choice once Gmail left the write path: a message
 * carried one label and no more, which is the only reason one ordering ever had to win.
 *
 * The two-level ones are here for a reason the three-level ones cannot fix: putting `entity` at
 * the leaf strands roughly 85% of unfiled mail just below the folder floor, because a brand-level
 * leaf is small by nature. `Subject area > What it wants` has no such tail.
 */
export const PIVOT_PRESETS: ReadonlyArray<{ order: PivotFacet[]; blurb: string }> = [
  { order: ['entity', 'intent'], blurb: 'Netflix, then what its mail wanted.' },
  { order: ['domain', 'intent'], blurb: 'Finance, then what its mail wanted. No long tail.' },
  { order: ['domain', 'intent', 'entity'], blurb: 'Finance, then payments, then who sent them.' },
  { order: ['intent', 'entity'], blurb: 'Every failed payment together, whoever sent it.' },
];

/** `entity,intent` — how an ordering is written in a URL, so a view is a link. */
export function pivotOrderKey(order: PivotFacet[]): string {
  return order.join(',');
}

/** `Brand > What it wants`, for a person. */
export function pivotOrderLabel(order: PivotFacet[]): string {
  return order.map((facet) => FACET_LABELS[facet]).join(' › ');
}

export interface PivotSettings {
  /** The one ordering that is materialised into Gmail. Every other is computed on read. */
  canonicalPivot: PivotFacet[];
  /** The floor under a folder: a combination with fewer messages than this does not become one. */
  minMessages: number;
}

export interface PivotNode {
  facetKey: string;
  /** Null at the top level. Walking these is how a breadcrumb is built. */
  parentFacetKey: string | null;
  fullPath: string;
  leafName: string;
  depth: number;
  messageCount: number;
  subtreeMessageCount: number;
  /** Unread mail in this exact folder, and in everything beneath it. */
  unreadCount: number;
  subtreeUnreadCount: number;
  isLeaf: boolean;
  latestReceivedAt?: string | null;
}

export interface PivotView {
  order: PivotFacet[];
  nodes: PivotNode[];
  /**
   * Mail that reached no folder, and why. The split matters when tuning the floor: mail below the
   * threshold comes back by lowering it, mail with no facet value does not.
   */
  unfiled: { total: number; noFacetValue: number; belowThreshold: number };
  /** Combinations too small to deserve a folder; their mail files one level up. */
  collapsed: number;
}

export interface PivotPlanChange extends PivotNode {
  /** KEEP reuses an existing folder and its Gmail label; CREATE is new. */
  action: 'KEEP' | 'CREATE';
  gmailLabelId: string | null;
}

export interface PivotPlan {
  order: PivotFacet[];
  minMessages: number;
  changes: PivotPlanChange[];
  /**
   * Folders that exist today and match no combination in this pivot. They are reported and left
   * alone: deleting a Gmail label does not unlabel the mail beneath it.
   */
  orphaned: Array<{ id: string; fullPath: string; gmailLabelId: string | null }>;
  unfiled: { total: number; noFacetValue: number; belowThreshold: number };
  collapsed: number;
  totalMessages: number;
  gmailLabelsToCreate: number;
}

export interface PivotApplyResult extends PivotPlan {
  rowsCreated: number;
  rowsKept: number;
  gmailLabelsCreated: number;
  gmailLabelsReused: number;
  gmailLabelsRenamed: number;
}

/** One message inside a folder. Metadata only — the body stays in Gmail. */
export interface FolderMessage {
  id: string;
  /** Gmail's own id, which is what the deep link addresses. */
  gmailMessageId: string;
  subject: string | null;
  senderName: string | null;
  senderEmail: string | null;
  snippet: string | null;
  receivedAt: string | null;
  isUnread: boolean;
  entity: string | null;
  domain: string | null;
  intent: string | null;
}

export interface FolderMessages {
  messages: FolderMessage[];
  /** Present while another page exists. One combination holds 1,823 messages. */
  nextCursor: string | null;
  total: number;
}

/**
 * One search hit: a message, plus where it sits under the ordering being viewed. The folder is
 * null when it sits in none — unclassified, or in a combination below the folder floor.
 */
export interface SearchHit extends FolderMessage {
  folder: { facetKey: string; fullPath: string; leafName: string } | null;
}

export interface SearchFilters {
  entity?: string;
  domain?: string;
  intent?: string;
  /** Only mail still unread in Gmail. On its own it answers "what arrived that I have not seen". */
  unread?: boolean;
}

/** A folder holding some of the matches, counted over the whole result set rather than one page. */
export interface SearchFolderGroup {
  facetKey: string | null;
  fullPath: string | null;
  leafName: string;
  count: number;
}

export interface SearchResults {
  query: string | null;
  filters: { entity: string | null; domain: string | null; intent: string | null; unread: boolean };
  order: PivotFacet[];
  results: SearchHit[];
  /** Which folders the matches live in, largest first. */
  folders: SearchFolderGroup[];
  total: number;
  nextCursor: string | null;
}

/** What there is to filter by, and how much mail sits behind each value. */
export interface FacetVocabulary {
  entity: Array<{ value: string; messageCount: number }>;
  domain: Array<{ value: string; messageCount: number }>;
  intent: Array<{ value: string; messageCount: number }>;
}
