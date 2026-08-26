/**
 * A message carries three orthogonal facets, and a folder tree is a **view** of them. `entity` is
 * the sending brand, derived in code; `domain` and `intent` come from two closed vocabularies.
 */
export type PivotFacet = 'entity' | 'domain' | 'intent';

export const PIVOT_FACETS: readonly PivotFacet[] = ['entity', 'domain', 'intent'];

/** How each facet reads to a person, so the screen never shows a column name. */
export const FACET_LABELS: Record<PivotFacet, string> = {
  entity: 'Brand',
  domain: 'Subject area',
  intent: 'What it wants',
};

export interface PivotSettings {
  /** The one ordering that is materialised into Gmail. Every other is computed on read. */
  canonicalPivot: PivotFacet[];
  /** The floor under a folder: a combination with fewer messages than this does not become one. */
  minMessages: number;
}

export interface PivotNode {
  facetKey: string;
  fullPath: string;
  leafName: string;
  depth: number;
  messageCount: number;
  subtreeMessageCount: number;
  isLeaf: boolean;
}

export interface PivotView {
  order: PivotFacet[];
  nodes: PivotNode[];
  /** Mail whose top facet is unknown, so it has no folder to go in and stays in the inbox. */
  unfiled: number;
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
  unfiled: number;
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
