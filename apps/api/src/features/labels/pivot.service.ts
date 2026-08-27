import { auditService } from '@api/audit/audit.service.js';
import { env } from '@api/config/env.js';
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
  /** Folders whose combination survived a change in how one of its values is spelled. */
  gmailLabelsRenamed: number;
}

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

/**
 * Turns `entity=netflix|intent=payment-failed` into the facet columns it constrains.
 *
 * Only the three real facets are accepted, so a key naming anything else selects nothing rather
 * than quietly widening to the whole mailbox — a malformed key must never return someone's entire
 * inbox under a folder heading.
 */
function facetFilterFromKey(facetKey: string): Record<string, string> {
  const filter: Record<string, string> = {};
  for (const part of facetKey.split('|')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const facet = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (!value) continue;
    if ((PIVOT_FACETS as readonly string[]).includes(facet)) filter[facet] = value;
  }
  // A key that constrains nothing would leave the where clause as the account alone and hand back
  // the entire mailbox under one folder heading. Refuse it instead.
  if (Object.keys(filter).length === 0) {
    throw new AppError('LABEL_VALIDATION_FAILED', 'That is not a folder.', 400);
  }
  return filter;
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
      select: {
        gmail_message_id: true,
        entity: true,
        domain: true,
        intent: true,
        // Read straight from the mailbox mirror, so a folder's unread badge tracks Gmail rather
        // than anything MailMind decided. Reading a message in Gmail clears it on the next sync.
        message: { select: { is_unread: true } },
      },
    });
    return rows.map((row) => ({
      id: row.gmail_message_id,
      entity: row.entity,
      domain: row.domain,
      intent: row.intent,
      unread: row.message.is_unread,
    }));
  }

  /**
   * The mail inside one folder of a pivot, newest first.
   *
   * A folder is a facet combination — `entity=netflix|intent=payment-failed` — and this reads the
   * messages matching it straight out of `message_facets`. It depends on no `user_labels` row and
   * on no `apply` ever having run, which is the point: the folder view is a projection of the
   * facets, not a reading-back of what was written to Gmail.
   *
   * **Subtree semantics.** Opening `entity=netflix` returns every Netflix message, including the
   * ones the pivot placed deeper under `Payment failed`. `buildPivot` puts a message at its
   * deepest surviving leaf because a message wears one label; a person clicking a parent folder is
   * asking a different question, and "everything under here" is the answer they mean.
   *
   * Metadata only, exactly as everywhere else: subject, sender, date, a stored snippet and the
   * Gmail id the deep link needs. No body, ever.
   */
  async folderMessages(
    accountId: string,
    facetKey: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<{ messages: FolderMessage[]; nextCursor: string | null; total: number }> {
    const where = {
      connected_google_account_id: accountId,
      ...facetFilterFromKey(facetKey),
    };
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const [total, rows] = await Promise.all([
      prisma.message_facets.count({ where }),
      prisma.message_facets.findMany({
        where,
        // Newest first, and by id after that so the cursor never straddles two messages that
        // arrived in the same second.
        orderBy: [{ message: { internal_date: 'desc' } }, { gmail_message_id: 'desc' }],
        take: limit + 1,
        ...(options.cursor ? { cursor: { gmail_message_id: options.cursor }, skip: 1 } : {}),
        select: {
          gmail_message_id: true,
          entity: true,
          domain: true,
          intent: true,
          message: {
            select: {
              gmail_message_id: true,
              subject: true,
              sender_name: true,
              sender_email: true,
              snippet: true,
              internal_date: true,
              is_unread: true,
            },
          },
        },
      }),
    ]);

    const page = rows.slice(0, limit);
    return {
      total,
      // One row beyond the page proves there is more, without a second count.
      nextCursor: rows.length > limit ? (page.at(-1)?.gmail_message_id ?? null) : null,
      messages: page.map((row) => ({
        id: row.gmail_message_id,
        gmailMessageId: row.message.gmail_message_id,
        subject: row.message.subject,
        senderName: row.message.sender_name,
        senderEmail: row.message.sender_email,
        snippet: row.message.snippet,
        receivedAt: row.message.internal_date?.toISOString() ?? null,
        isUnread: row.message.is_unread,
        entity: row.entity,
        domain: row.domain,
        intent: row.intent,
      })),
    };
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
  async apply(accountId: string, userId: string): Promise<PivotApplyResult> {
    // Opt-in, and off by default, for the same reason filing is: this is the only step here that
    // creates anything in someone's mailbox. `plan` and `view` stay open — they are pure functions
    // of the facet rows, and the PWA's folders are built from them rather than from what was
    // written to Gmail.
    if (!env.GMAIL_WRITE_ENABLED) {
      throw new AppError(
        'GMAIL_WRITE_DISABLED',
        'MailMind is not set up to write labels into Gmail.',
        503,
      );
    }
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

    const rowByFacetKey = new Map(
      existing.filter((row) => row.facet_key).map((row) => [row.facet_key!, row]),
    );
    /** Folders whose combination is unchanged but whose spelling is not. */
    const renamed: Array<{ from: string; to: string; gmailLabelId: string | null }> = [];

    for (const change of sorted) {
      const node = plan.changes.find((entry) => entry.facetKey === change.facetKey)!;
      const parentFacetKey = parentKeyOf(change.facetKey);
      const parentId = parentFacetKey ? (idByFacetKey.get(parentFacetKey) ?? null) : null;
      if (parentFacetKey && !parentId) {
        // Its parent was skipped, so this folder has nowhere to hang. Its mail stays in the inbox.
        continue;
      }
      const leafName = node.fullPath.split('/').at(-1)!;
      // The same normal form every other writer uses. Two spellings of "normalised" under one
      // uniqueness index would let near-duplicate siblings both insert.
      const spelling = {
        leaf_name: leafName,
        full_path: node.fullPath,
        normalized_name: normalizeLabelForComparison(leafName),
      };

      // Identity is the facet key, not the path. Writing by path instead would meet an existing
      // row's facet key on the unique index and fail the whole apply the first time a value's
      // spelling changed — and a spelling change is the one thing a folder is allowed to survive.
      const current = rowByFacetKey.get(change.facetKey);
      let row;
      if (current) {
        if (current.full_path !== node.fullPath) {
          renamed.push({
            from: current.full_path,
            to: node.fullPath,
            gmailLabelId: current.gmail_label_id,
          });
        }
        row = await prisma.user_labels.update({
          where: { id: current.id },
          data: { ...spelling, parent_id: parentId, depth: change.depth },
        });
      } else {
        row = await prisma.user_labels.upsert({
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
            ...spelling,
            facet_key: change.facetKey,
            source: 'AI_PROPOSED',
          },
          update: { facet_key: change.facetKey, parent_id: parentId, depth: change.depth },
        });
      }
      idByFacetKey.set(change.facetKey, row.id);
      if (change.action === 'CREATE') rowsCreated += 1;
      else rowsKept += 1;
    }

    // A renamed folder keeps its Gmail label id, so the mail already under it stays under it.
    // Creating a second label at the new spelling would strand every message beneath the old one,
    // because deleting a Gmail label never unlabels the mail it carried.
    let gmailLabelsRenamed = 0;
    for (const rename of renamed) {
      if (!rename.gmailLabelId) continue;
      await this.gmail.renameLabel(accountId, rename.gmailLabelId, rename.to);
      gmailLabelsRenamed += 1;
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

    // Creating folders in someone's mailbox is a Gmail mutation like any other, and every other
    // one leaves a trail. Deletions never appear here because the pivot never deletes.
    await auditService.record({
      action: 'labels.pivot.applied',
      result: 'SUCCESS',
      userId,
      metadata: {
        pivot: plan.order.join('>'),
        minMessages: plan.minMessages,
        rowsCreated,
        rowsKept,
        gmailLabelsCreated,
        gmailLabelsReused,
        gmailLabelsRenamed,
        orphanedLeftAlone: plan.orphaned.length,
      },
    });
    return {
      ...plan,
      rowsCreated,
      rowsKept,
      gmailLabelsCreated,
      gmailLabelsReused,
      gmailLabelsRenamed,
    };
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
