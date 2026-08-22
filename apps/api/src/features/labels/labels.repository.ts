import { randomUUID } from 'node:crypto';
import type {
  Prisma,
  routing_rule_kind,
  taxonomy_node_kind,
  user_label_source,
  user_labels,
} from '@prisma/client';

import { env } from '@api/config/env.js';
import { prisma } from '@api/database/prisma.js';
import { AppError } from '@api/errors/AppError.js';
import { normalizeLabelForComparison } from '@api/features/label-discovery/label-normalization.js';
import { RULE_PRIORITY } from '@api/features/label-discovery/routing-rules.js';
import {
  LABEL_ROOT,
  gmailPathFor,
  type PlannedNode,
  type TaxonomyPlan,
} from '@api/features/label-discovery/taxonomy-planner.js';

const PROPOSAL_LEASE_SECONDS = 120;

/**
 * Mail a planner may learn from: present, not draft/sent/trashed, not spam, and inside the given
 * lookback window. Shared so the two planners apply the same eligibility rules; only how far back
 * they look differs, because a folder tree is designed from recent mail while a facet vocabulary
 * has to cover everything the classifier will be asked about.
 */
function eligibleMessageWhere(
  accountId: string,
  lookbackDays: number,
): Prisma.gmail_message_metadataWhereInput {
  return {
    connected_google_account_id: accountId,
    deleted_at: null,
    is_draft: false,
    is_sent: false,
    is_trashed: false,
    internal_date: {
      gte: new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000),
    },
    sender_email: { not: null },
    NOT: { label_ids: { hasSome: ['SPAM', 'TRASH', 'DRAFT'] } },
  };
}

export interface ProposalLease {
  accountId: string;
  token: string;
}

/** The Gmail label name for a tree path such as "Job hunt/Applications sent". */
export function labelPathFor(treePath: string): string {
  return gmailPathFor(treePath);
}

/** The tree path stored on a label row, without the MailMind namespace. */
export function treePathOf(label: Pick<user_labels, 'full_path'>): string {
  return label.full_path.slice(LABEL_ROOT.length + 1);
}

export class LabelsRepository {
  async activeAccountForUser(userId: string) {
    const account = await prisma.connected_google_accounts.findFirst({
      where: { user_id: userId, gmail_connected: true, connection_status: 'CONNECTED' },
      orderBy: { updated_at: 'desc' },
    });
    if (!account) {
      throw new AppError('GMAIL_ACCOUNT_NOT_CONNECTED', 'Connect Gmail before using labels.', 409);
    }
    return account;
  }

  /**
   * Proposals share the automation lease: a proposal must never run while automation is
   * applying labels for the same account, and vice versa.
   */
  async acquireProposalLease(accountId: string): Promise<ProposalLease> {
    await prisma.automation_states.upsert({
      where: { connected_google_account_id: accountId },
      create: { connected_google_account_id: accountId },
      update: {},
    });
    const now = new Date();
    const token = randomUUID();
    const acquired = await prisma.automation_states.updateMany({
      where: {
        connected_google_account_id: accountId,
        OR: [{ lease_expires_at: null }, { lease_expires_at: { lt: now } }],
      },
      data: {
        lease_token: token,
        lease_expires_at: new Date(now.getTime() + PROPOSAL_LEASE_SECONDS * 1000),
      },
    });
    if (acquired.count !== 1) {
      throw new AppError(
        'LABEL_PROPOSAL_ALREADY_RUNNING',
        'Another label or automation run is active for this Gmail account.',
        409,
      );
    }
    return { accountId, token };
  }

  async releaseProposalLease(lease: ProposalLease): Promise<void> {
    await prisma.automation_states.updateMany({
      where: {
        connected_google_account_id: lease.accountId,
        lease_token: lease.token,
      },
      data: { lease_token: null, lease_expires_at: null },
    });
  }

  /** The population the planner samples from. Metadata only, as everywhere else. */
  eligibleMessages(accountId: string) {
    return prisma.gmail_message_metadata.findMany({
      where: eligibleMessageWhere(accountId, env.TAXONOMY_LOOKBACK_DAYS),
      select: {
        id: true,
        subject: true,
        sender_name: true,
        sender_email: true,
        internal_date: true,
      },
      orderBy: [{ internal_date: 'desc' }, { id: 'desc' }],
      take: env.TAXONOMY_MAX_MESSAGES,
    });
  }

  /**
   * The same eligible mail, each message paired with the folder the current classifier actually
   * filed it into. Read-only evidence for facet vocabulary design: a message with no action row,
   * or one whose decision was NONE, has a null path and is exactly the mail the facets exist to
   * cover. Its own message ceiling and lookback are separate from the tree planner's, because the
   * vocabulary is designed from the whole mailbox rather than a recent slice of it.
   */
  facetEvidenceMessages(accountId: string) {
    return prisma.gmail_message_metadata.findMany({
      where: eligibleMessageWhere(accountId, env.FACET_LOOKBACK_DAYS),
      select: {
        id: true,
        subject: true,
        sender_name: true,
        sender_email: true,
        internal_date: true,
        automationAction: { select: { label_path: true } },
      },
      orderBy: [{ internal_date: 'desc' }, { id: 'desc' }],
      take: env.FACET_MAX_MESSAGES,
    });
  }

  async existingGmailLabelNames(accountId: string): Promise<string[]> {
    const labels = await prisma.gmail_labels.findMany({
      where: { connected_google_account_id: accountId },
      select: { name: true },
    });
    // MailMind's own labels are not competition for a proposed name.
    return labels
      .map((label) => label.name)
      .filter((name) => !name.startsWith(`${LABEL_ROOT}/`))
      .map((name) => name.split('/').at(-1) ?? name);
  }

  approvedLabels(accountId: string) {
    return prisma.user_labels.findMany({
      where: { connected_google_account_id: accountId },
      orderBy: [{ depth: 'asc' }, { full_path: 'asc' }],
    });
  }

  approvedLeafLabels(accountId: string) {
    return prisma.user_labels.findMany({
      where: { connected_google_account_id: accountId, children: { none: {} } },
      orderBy: [{ depth: 'asc' }, { full_path: 'asc' }],
    });
  }

  /**
   * Looks a folder up by its leaf name.
   *
   * Names are unique among SIBLINGS rather than across the account, because a pivot repeats its
   * lower levels by construction — Netflix > Payment failed and Coursera > Payment failed are two
   * folders with one name. A bare name is therefore no longer an identifier, and this resolves the
   * shallowest match deterministically instead of assuming there is only one. Callers that need an
   * exact folder should address it by `full_path` or `facet_key`.
   */
  approvedLabelByLeaf(accountId: string, leafName: string) {
    return prisma.user_labels.findFirst({
      where: {
        connected_google_account_id: accountId,
        normalized_name: normalizeLabelForComparison(leafName),
      },
      orderBy: [{ depth: 'asc' }, { full_path: 'asc' }],
    });
  }

  pendingPlan(accountId: string) {
    return prisma.taxonomy_plans.findFirst({
      where: { connected_google_account_id: accountId, status: 'PENDING' },
      orderBy: { created_at: 'desc' },
      include: {
        nodes: {
          orderBy: [{ depth: 'asc' }, { position: 'asc' }],
          include: { rules: { orderBy: { match_value: 'asc' } } },
        },
      },
    });
  }

  planForAccount(accountId: string, planId: string) {
    return prisma.taxonomy_plans.findFirst({
      where: { id: planId, connected_google_account_id: accountId },
      include: {
        nodes: {
          orderBy: [{ depth: 'asc' }, { position: 'asc' }],
          include: { rules: { orderBy: { match_value: 'asc' } } },
        },
      },
    });
  }

  /**
   * Replaces whatever plan was awaiting review. A plan is one indivisible proposal, so a new run
   * supersedes the old one rather than merging into it.
   */
  async storePlan(accountId: string, plan: TaxonomyPlan) {
    return prisma.$transaction(async (transaction) => {
      await transaction.taxonomy_plans.updateMany({
        where: { connected_google_account_id: accountId, status: 'PENDING' },
        data: { status: 'SUPERSEDED' },
      });
      const stored = await transaction.taxonomy_plans.create({
        data: {
          connected_google_account_id: accountId,
          model: plan.model,
          prompt_version: plan.promptVersion,
          sampled_message_count: plan.sampledMessageCount,
          analyzed_message_count: plan.analyzedMessageCount,
          leaf_count: plan.nodes.filter((node) => node.isLeaf).length,
          input_tokens: plan.usage.inputTokens,
          output_tokens: plan.usage.outputTokens,
          estimated_cost_microusd: plan.estimatedCostMicrousd,
          warnings: plan.warnings.slice(0, 100),
        },
      });
      const idByPath = new Map<string, string>();
      // Shallowest first so a child always finds its parent's freshly created id.
      for (const [position, node] of plan.nodes.entries()) {
        const created = await transaction.taxonomy_plan_nodes.create({
          data: {
            plan_id: stored.id,
            parent_id: node.parentPath ? (idByPath.get(node.parentPath) ?? null) : null,
            depth: node.depth,
            kind: node.kind as taxonomy_node_kind,
            name: node.name,
            full_path: gmailPathFor(node.path),
            normalized_name: node.normalizedName,
            rationale: node.rationale,
            estimated_message_count: node.estimatedMessageCount,
            matched_message_count: node.matchedMessageCount,
            is_leaf: node.isLeaf,
            position,
            rules: {
              create: node.rules.map((rule) => ({
                rule_kind: rule.kind as routing_rule_kind,
                match_value: rule.value,
                matched_message_count: rule.matchedMessageCount,
              })),
            },
          },
        });
        idByPath.set(node.path, created.id);
      }
      return stored.id;
    });
  }

  async markPlanApproved(planId: string): Promise<void> {
    await prisma.taxonomy_plans.updateMany({
      where: { id: planId, status: 'PENDING' },
      data: { status: 'APPROVED', approved_at: new Date() },
    });
  }

  createLabel(input: {
    accountId: string;
    name: string;
    treePath: string;
    depth: number;
    parentId: string | null;
    source: user_label_source;
    rationale?: string | null;
  }): Promise<user_labels> {
    return prisma.user_labels.create({
      data: {
        connected_google_account_id: input.accountId,
        parent_id: input.parentId,
        depth: input.depth,
        leaf_name: input.name,
        full_path: labelPathFor(input.treePath),
        normalized_name: normalizeLabelForComparison(input.name),
        rationale: input.rationale ?? null,
        source: input.source,
      },
    });
  }

  setGmailLabelId(id: string, gmailLabelId: string): Promise<user_labels> {
    return prisma.user_labels.update({ where: { id }, data: { gmail_label_id: gmailLabelId } });
  }

  /**
   * Renaming a folder rewrites its descendants' paths too, parent before children so the tree
   * trigger always sees a consistent chain.
   */
  async renameLabel(label: user_labels, name: string): Promise<user_labels[]> {
    const oldPath = label.full_path;
    const parentPath = oldPath.slice(0, oldPath.lastIndexOf('/'));
    const newPath = `${parentPath}/${name}`;
    const descendants = await prisma.user_labels.findMany({
      where: {
        connected_google_account_id: label.connected_google_account_id,
        full_path: { startsWith: `${oldPath}/` },
      },
      orderBy: { depth: 'asc' },
    });
    return prisma.$transaction(async (transaction) => {
      const updated = [
        await transaction.user_labels.update({
          where: { id: label.id },
          data: {
            leaf_name: name,
            full_path: newPath,
            normalized_name: normalizeLabelForComparison(name),
          },
        }),
      ];
      for (const descendant of descendants) {
        updated.push(
          await transaction.user_labels.update({
            where: { id: descendant.id },
            data: { full_path: `${newPath}${descendant.full_path.slice(oldPath.length)}` },
          }),
        );
      }
      return updated;
    });
  }

  deleteLabel(id: string): Promise<user_labels> {
    return prisma.user_labels.delete({ where: { id } });
  }

  async labelForAccount(accountId: string, id: string): Promise<user_labels> {
    const label = await prisma.user_labels.findFirst({
      where: { id, connected_google_account_id: accountId },
    });
    if (!label) {
      throw new AppError('LABEL_NOT_FOUND', 'That label was not found for this account.', 404);
    }
    return label;
  }

  descendantsOf(label: user_labels) {
    return prisma.user_labels.findMany({
      where: {
        connected_google_account_id: label.connected_google_account_id,
        full_path: { startsWith: `${label.full_path}/` },
      },
      orderBy: { depth: 'asc' },
    });
  }

  /**
   * Installs the approved plan's rules as the account's planner rules. Rules learned from applied
   * mail are left alone: they encode what the user actually accepted.
   */
  async replacePlannerRules(
    accountId: string,
    rules: Array<{
      kind: routing_rule_kind;
      value: string;
      labelId: string;
      labelName: string;
      labelPath: string;
    }>,
  ): Promise<number> {
    return prisma.$transaction(async (transaction) => {
      await transaction.learned_classification_patterns.deleteMany({
        where: { connected_google_account_id: accountId, rule_source: 'PLANNER' },
      });
      let stored = 0;
      for (const rule of rules) {
        const data: Prisma.learned_classification_patternsUncheckedCreateInput = {
          connected_google_account_id: accountId,
          rule_kind: rule.kind,
          match_value: rule.value,
          rule_source: 'PLANNER',
          user_label_id: rule.labelId,
          priority: RULE_PRIORITY[rule.kind],
          label_name: rule.labelName,
          label_path: rule.labelPath,
          // A rule the user approved is authoritative; the executor applies it without a model.
          confidence: 1,
          sample_count: 1,
        };
        await transaction.learned_classification_patterns.upsert({
          where: {
            connected_google_account_id_rule_kind_match_value: {
              connected_google_account_id: accountId,
              rule_kind: rule.kind,
              match_value: rule.value,
            },
          },
          create: data,
          update: {
            rule_source: 'PLANNER',
            user_label_id: rule.labelId,
            label_name: rule.labelName,
            label_path: rule.labelPath,
            priority: RULE_PRIORITY[rule.kind],
            confidence: 1,
            active: true,
          },
        });
        stored += 1;
      }
      return stored;
    });
  }

  routingRules(accountId: string) {
    return prisma.learned_classification_patterns.findMany({
      where: { connected_google_account_id: accountId, active: true },
      orderBy: [{ priority: 'asc' }, { confidence: 'desc' }],
    });
  }
}

export const labelsRepository = new LabelsRepository();
export type { PlannedNode };
