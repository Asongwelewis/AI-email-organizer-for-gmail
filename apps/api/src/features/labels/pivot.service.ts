import { prisma } from '@api/database/prisma.js';
import { AppError } from '@api/errors/AppError.js';
import { normalizeLabelForComparison } from '@api/features/label-discovery/label-normalization.js';
import {
  ALTERNATE_PIVOT,
  DEFAULT_PIVOT,
  PIVOT_FACETS,
  buildPivot,
  type FacetedMessage,
  type PivotFacet,
  type PivotResult,
} from '@api/features/label-discovery/pivot.js';
import {
  automationGmailService,
  type AutomationGmailService,
} from '@api/features/automation/automation-gmail.service.js';

/**
 * Materialises one facet ordering into folders, and computes every other ordering on read.
 *
 * Exactly one pivot reaches Gmail, because a message carries one MailMind label and no more. The
 * alternate orderings are answers to "what would this look like arranged the other way", and they
 * are produced from `message_facets` without a single remote call — which is the whole point of
 * storing facets rather than a path.
 */

export interface PivotPlanChange {
  facetKey: string;
  fullPath: string;
  depth: number;
  messageCount: number;
  subtreeMessageCount: number;
  isLeaf: boolean;
  /** KEEP reuses an existing row and its Gmail label; CREATE is new. */
  action: 'KEEP' | 'CREATE';
  gmailLabelId: string | null;
}

export interface PivotPlan {
  order: PivotFacet[];
  minMessages: number;
  changes: PivotPlanChange[];
  /** Folders that exist today and correspond to no facet combination in this pivot. */
  orphaned: Array<{ id: string; fullPath: string; gmailLabelId: string | null }>;
  unfiled: PivotResult['unfiled'];
  collapsed: number;
  totalMessages: number;
  /** Leaves whose path does not exist in Gmail yet, so applying would create them. */
  gmailLabelsToCreate: number;
}

export interface PivotApplyResult extends PivotPlan {
  rowsCreated: number;
  rowsKept: number;
  gmailLabelsCreated: number;
  gmailLabelsReused: number;
}

function parsePivot(values: string[], fallback: PivotFacet[]): PivotFacet[] {
  const parsed = values.filter((value): value is PivotFacet =>
    (PIVOT_FACETS as readonly string[]).includes(value),
  );
  return parsed.length > 0 ? parsed : fallback;
}

export class PivotService {
  constructor(private readonly gmail: AutomationGmailService = automationGmailService) {}

  async settings(accountId: string) {
    const stored = await prisma.facet_pivot_settings.upsert({
      where: { connected_google_account_id: accountId },
      create: { connected_google_account_id: accountId },
      update: {},
    });
    return {
      canonicalPivot: parsePivot(stored.canonical_pivot, DEFAULT_PIVOT),
      minMessages: stored.min_messages,
    };
  }

  async facetedMessages(accountId: string): Promise<FacetedMessage[]> {
    const rows = await prisma.message_facets.findMany({
      where: { connected_google_account_id: accountId },
      select: { gmail_message_id: true, entity: true, domain: true, intent: true },
    });
    return rows.map((row) => ({
      id: row.gmail_message_id,
      entity: row.entity,
      domain: row.domain,
      intent: row.intent,
    }));
  }

  /**
   * Any ordering, computed on read. Never writes, never calls Gmail — an alternate view is a
   * question about the mail, not a change to it.
   */
  async view(
    accountId: string,
    order: PivotFacet[] = ALTERNATE_PIVOT,
    minMessages?: number,
  ): Promise<PivotResult> {
    const settings = await this.settings(accountId);
    return buildPivot(await this.facetedMessages(accountId), order, {
      minMessages: minMessages ?? settings.minMessages,
    });
  }

  /**
   * What applying the canonical pivot would do. Nothing is written and Gmail is not called.
   *
   * A folder is matched to its combination by `facet_key`, not by name or path: the name is only
   * how a folder is spelled, and a folder that already exists must keep its row and its Gmail
   * label rather than being deleted and recreated under a new id.
   */
  async plan(accountId: string): Promise<PivotPlan> {
    const settings = await this.settings(accountId);
    const messages = await this.facetedMessages(accountId);
    const pivot = buildPivot(messages, settings.canonicalPivot, {
      minMessages: settings.minMessages,
    });

    const existing = await prisma.user_labels.findMany({
      where: { connected_google_account_id: accountId },
    });
    const byFacetKey = new Map(
      existing.filter((row) => row.facet_key).map((row) => [row.facet_key!, row]),
    );
    // A folder the tree planner created carries no facet key, so it is matched by path instead:
    // if the pivot produces the same path, that row and its Gmail label are adopted rather than
    // duplicated. This is what stops the pivot recreating labels that already exist in Gmail.
    const byPath = new Map(existing.map((row) => [row.full_path, row]));

    const gmailLabels = await prisma.gmail_labels.findMany({
      where: { connected_google_account_id: accountId },
      select: { name: true, gmail_label_id: true },
    });
    const gmailByName = new Map(gmailLabels.map((label) => [label.name, label.gmail_label_id]));

    const changes: PivotPlanChange[] = [];
    const claimed = new Set<string>();
    for (const node of pivot.nodes) {
      const match = byFacetKey.get(node.facetKey) ?? byPath.get(node.fullPath);
      if (match) claimed.add(match.id);
      changes.push({
        facetKey: node.facetKey,
        fullPath: node.fullPath,
        depth: node.depth,
        messageCount: node.messageCount,
        subtreeMessageCount: node.subtreeMessageCount,
        isLeaf: node.isLeaf,
        action: match ? 'KEEP' : 'CREATE',
        gmailLabelId: match?.gmail_label_id ?? gmailByName.get(node.fullPath) ?? null,
      });
    }

    return {
      order: pivot.order,
      minMessages: settings.minMessages,
      changes,
      orphaned: existing
        .filter((row) => !claimed.has(row.id))
        .map((row) => ({
          id: row.id,
          fullPath: row.full_path,
          gmailLabelId: row.gmail_label_id,
        })),
      unfiled: pivot.unfiled,
      collapsed: pivot.collapsed,
      totalMessages: messages.length,
      // Only a leaf is ever created remotely: Gmail nesting is cosmetic, so a branch is a container
      // in the database and nothing at all in the mailbox.
      gmailLabelsToCreate: changes.filter((change) => change.isLeaf && !change.gmailLabelId).length,
    };
  }

  /**
   * Writes the canonical pivot into `user_labels` and creates the missing LEAF paths in Gmail.
   *
   * The only step here that leaves the database is `ensureLabel`, and it is idempotent: it adopts
   * a label that already exists by that name and creates one only when none does. Orphaned folders
   * are reported, never deleted — deleting a Gmail label does not unlabel the mail under it, so
   * removing folders is a decision for a person, not a side effect of re-running a pivot.
   */
  async apply(accountId: string): Promise<PivotApplyResult> {
    const plan = await this.plan(accountId);
    let rowsCreated = 0;
    let rowsKept = 0;

    // Shallowest first: the tree trigger resolves a child against its parent, so a parent that
    // does not exist yet is a failed insert rather than a deferred one.
    const sorted = [...plan.changes].sort((left, right) => left.depth - right.depth);
    const idByFacetKey = new Map<string, string>();
    const existing = await prisma.user_labels.findMany({
      where: { connected_google_account_id: accountId },
    });
    for (const row of existing) {
      if (row.facet_key) idByFacetKey.set(row.facet_key, row.id);
    }

    for (const change of sorted) {
      const node = plan.changes.find((entry) => entry.facetKey === change.facetKey)!;
      const parentFacetKey = parentKeyOf(change.facetKey);
      const parentId = parentFacetKey ? (idByFacetKey.get(parentFacetKey) ?? null) : null;
      if (parentFacetKey && !parentId) {
        // Its parent was skipped, so this folder has nowhere to hang. Its mail stays in the inbox.
        continue;
      }
      const leafName = node.fullPath.split('/').at(-1)!;
      const row = await prisma.user_labels.upsert({
        where: {
          connected_google_account_id_full_path: {
            connected_google_account_id: accountId,
            full_path: node.fullPath,
          },
        },
        create: {
          connected_google_account_id: accountId,
          parent_id: parentId,
          depth: change.depth,
          leaf_name: leafName,
          full_path: node.fullPath,
          // The same normal form every other writer uses. Two spellings of "normalised" under one
          // uniqueness index would let near-duplicate siblings both insert.
          normalized_name: normalizeLabelForComparison(leafName),
          facet_key: change.facetKey,
          source: 'AI_PROPOSED',
        },
        update: { facet_key: change.facetKey, parent_id: parentId, depth: change.depth },
      });
      idByFacetKey.set(change.facetKey, row.id);
      if (change.action === 'CREATE') rowsCreated += 1;
      else rowsKept += 1;
    }

    let gmailLabelsCreated = 0;
    let gmailLabelsReused = 0;
    for (const change of plan.changes) {
      if (!change.isLeaf) continue;
      const remote = await this.gmail.ensureLabel(accountId, change.fullPath);
      if (remote.created) gmailLabelsCreated += 1;
      else gmailLabelsReused += 1;
      await prisma.user_labels.updateMany({
        where: { connected_google_account_id: accountId, full_path: change.fullPath },
        data: { gmail_label_id: remote.id },
      });
    }

    return { ...plan, rowsCreated, rowsKept, gmailLabelsCreated, gmailLabelsReused };
  }

  async setPivot(accountId: string, order: PivotFacet[], minMessages?: number): Promise<void> {
    if (order.length === 0 || new Set(order).size !== order.length) {
      throw new AppError('LABEL_VALIDATION_FAILED', 'A pivot must be distinct facet names.', 422);
    }
    await prisma.facet_pivot_settings.upsert({
      where: { connected_google_account_id: accountId },
      create: {
        connected_google_account_id: accountId,
        canonical_pivot: order,
        ...(minMessages === undefined ? {} : { min_messages: minMessages }),
      },
      update: {
        canonical_pivot: order,
        ...(minMessages === undefined ? {} : { min_messages: minMessages }),
      },
    });
  }
}

function parentKeyOf(facetKey: string): string | null {
  const parts = facetKey.split('|');
  return parts.length > 1 ? parts.slice(0, -1).join('|') : null;
}

export const pivotService = new PivotService();
