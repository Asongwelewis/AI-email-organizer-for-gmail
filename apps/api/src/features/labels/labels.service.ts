import type { routing_rule_kind, user_label_source, user_labels } from '@prisma/client';

import { auditService } from '@api/audit/audit.service.js';
import { env } from '@api/config/env.js';
import { logger } from '@api/config/logger.js';
import { AppError } from '@api/errors/AppError.js';
import {
  automationGmailService,
  type AutomationGmailService,
} from '@api/features/automation/automation-gmail.service.js';
import {
  isGenericLabelName,
  labelsAreSimilar,
  validateLeafName,
} from '@api/features/label-discovery/label-normalization.js';
import {
  TAXONOMY_LIMITS,
  geminiTaxonomyPlanner,
  type PlannerMessage,
  type TaxonomyPlanner,
} from '@api/features/label-discovery/taxonomy-planner.js';
import {
  labelPathFor,
  labelsRepository,
  treePathOf,
  type LabelsRepository,
} from './labels.repository.js';

export interface ManualLabelInput {
  leafName: string;
  parentId?: string | null | undefined;
  source: user_label_source;
}

export interface ApprovePlanInput {
  planId: string;
  /** Omitted means the whole tree. Selecting a node implicitly selects its ancestors. */
  nodeIds?: string[] | undefined;
}

type PlanWithNodes = NonNullable<Awaited<ReturnType<LabelsRepository['pendingPlan']>>>;
type PlanNode = PlanWithNodes['nodes'][number];

function invalidName(leafName: string): AppError {
  return new AppError(
    'LABEL_NAME_INVALID',
    `"${leafName}" is not a usable label name. Use 2-60 characters, no slashes, and something more specific than a generic word.`,
    400,
  );
}

export class LabelsService {
  constructor(
    private readonly repository: LabelsRepository = labelsRepository,
    private readonly gmail: AutomationGmailService = automationGmailService,
    private readonly planner: TaxonomyPlanner = geminiTaxonomyPlanner,
  ) {}

  /** Normalizes and validates a leaf name, rejecting generic and malformed values. */
  private safeLeafName(leafName: string): string {
    if (isGenericLabelName(leafName)) throw invalidName(leafName);
    try {
      return validateLeafName(leafName);
    } catch {
      throw invalidName(leafName);
    }
  }

  async list(userId: string) {
    const account = await this.repository.activeAccountForUser(userId);
    const [labels, plan] = await Promise.all([
      this.repository.approvedLabels(account.id),
      this.repository.pendingPlan(account.id),
    ]);
    const parentIds = new Set(labels.map((label) => label.parent_id).filter(Boolean));
    return {
      maxLabels: env.AUTOMATION_MAX_LABELS,
      maxDepth: TAXONOMY_LIMITS.maxDepth,
      labels: labels.map((label) => this.serialize(label, !parentIds.has(label.id))),
      plan: plan ? this.serializePlan(plan) : null,
    };
  }

  /**
   * One planning call designs the whole tree from a sample of stored metadata. Nothing is created
   * in Gmail here: the plan exists to be reviewed.
   */
  async propose(userId: string) {
    const account = await this.repository.activeAccountForUser(userId);
    const lease = await this.repository.acquireProposalLease(account.id);
    try {
      const [records, gmailLabelNames] = await Promise.all([
        this.repository.eligibleMessages(account.id),
        this.repository.existingGmailLabelNames(account.id),
      ]);
      if (records.length < TAXONOMY_LIMITS.minLeafMessages) {
        throw new AppError(
          'LABEL_PROPOSAL_NOT_ENOUGH_MAIL',
          'Synchronize more mail before proposing a folder tree.',
          422,
        );
      }
      const messages: PlannerMessage[] = records.map((message) => ({
        id: message.id,
        subject: message.subject,
        senderName: message.sender_name,
        senderEmail: message.sender_email,
        internalDate: message.internal_date,
      }));
      // The Gemini call happens outside any transaction so a slow provider never holds one open.
      const plan = await this.planner.plan({ messages, existingGmailLabelNames: gmailLabelNames });
      await this.repository.storePlan(account.id, plan);
      logger.info(
        {
          accountId: account.id,
          nodes: plan.nodes.length,
          leaves: plan.nodes.filter((node) => node.isLeaf).length,
          sampled: plan.sampledMessageCount,
          warnings: plan.warnings.length,
        },
        'taxonomy plan proposed',
      );
      await auditService.record({
        userId,
        action: 'labels.proposed',
        result: 'SUCCESS',
        metadata: {
          nodes: plan.nodes.length,
          analyzed: plan.analyzedMessageCount,
          sampled: plan.sampledMessageCount,
        },
      });
      return this.list(userId);
    } finally {
      await this.repository.releaseProposalLease(lease);
    }
  }

  /**
   * Human approval. Only this creates folders, and only leaves are created in Gmail: Gmail
   * nesting is cosmetic, so `MailMind/Job hunt/Applications sent` is one label whose name happens
   * to contain slashes. The intermediate rows exist here so the app can render real folders.
   */
  async approvePlan(userId: string, input: ApprovePlanInput) {
    const account = await this.repository.activeAccountForUser(userId);
    const plan = await this.repository.planForAccount(account.id, input.planId);
    if (!plan) throw new AppError('LABEL_PLAN_NOT_FOUND', 'That plan was not found.', 404);
    if (plan.status !== 'PENDING') {
      throw new AppError('LABEL_PLAN_NOT_PENDING', 'That plan was already reviewed.', 409);
    }
    const selected = this.selectedNodes(plan, input.nodeIds);
    const existing = await this.repository.approvedLabels(account.id);
    const leafCount =
      existing.filter((label) => !existing.some((other) => other.parent_id === label.id)).length +
      selected.filter((node) => node.is_leaf).length;
    if (leafCount > env.AUTOMATION_MAX_LABELS) {
      throw new AppError(
        'LABEL_LIMIT_REACHED',
        `That would leave ${leafCount} folders; this account allows ${env.AUTOMATION_MAX_LABELS}.`,
        409,
      );
    }

    const labelByPlanNodeId = new Map<string, user_labels>();
    const created: user_labels[] = [];
    // Shallowest first so a child always has a parent row to point at.
    for (const node of selected) {
      const treePath = node.full_path.slice('MailMind/'.length);
      const alreadyStored =
        existing.find((label) => label.full_path === node.full_path) ??
        existing.find((label) => labelsAreSimilar(label.leaf_name, node.name));
      if (alreadyStored) {
        labelByPlanNodeId.set(node.id, alreadyStored);
        continue;
      }
      const parent = node.parent_id ? labelByPlanNodeId.get(node.parent_id) : null;
      const label = await this.repository.createLabel({
        accountId: account.id,
        name: node.name,
        treePath,
        depth: node.depth,
        parentId: parent?.id ?? null,
        source: 'AI_PROPOSED',
        rationale: node.rationale,
      });
      labelByPlanNodeId.set(node.id, label);
      created.push(label);
    }

    // Gmail work happens outside the database writes so a partial failure stays resumable.
    for (const node of selected) {
      if (!node.is_leaf) continue;
      const label = labelByPlanNodeId.get(node.id);
      if (!label || label.gmail_label_id) continue;
      const remote = await this.gmail.ensureLabel(account.id, label.full_path);
      const updated = await this.repository.setGmailLabelId(label.id, remote.id);
      labelByPlanNodeId.set(node.id, updated);
    }

    const rules = selected.flatMap((node) => {
      const label = labelByPlanNodeId.get(node.id);
      if (!label) return [];
      return node.rules.map((rule) => ({
        kind: rule.rule_kind as routing_rule_kind,
        value: rule.match_value,
        labelId: label.id,
        labelName: label.leaf_name,
        labelPath: label.full_path,
      }));
    });
    const storedRules = await this.repository.replacePlannerRules(account.id, rules);
    await this.repository.markPlanApproved(plan.id);
    await auditService.record({
      userId,
      action: 'labels.confirmed',
      result: 'SUCCESS',
      metadata: { planId: plan.id, labels: created.length, rules: storedRules },
    });
    return this.list(userId);
  }

  /** Manual folder creation. Names still go through the same duplicate and naming rules. */
  async confirm(userId: string, requested: ManualLabelInput[]) {
    const account = await this.repository.activeAccountForUser(userId);
    if (requested.length === 0) {
      throw new AppError('LABEL_SET_EMPTY', 'Confirm at least one label.', 400);
    }
    const names = requested.map((label) => this.safeLeafName(label.leafName));
    for (let index = 0; index < names.length; index += 1) {
      for (let other = index + 1; other < names.length; other += 1) {
        if (labelsAreSimilar(names[index]!, names[other]!)) {
          throw new AppError(
            'LABEL_DUPLICATE',
            `"${names[index]}" and "${names[other]}" are too similar to keep both.`,
            409,
          );
        }
      }
    }
    const existing = await this.repository.approvedLabels(account.id);
    const created: user_labels[] = [];
    for (const [index, leafName] of names.entries()) {
      const alreadyStored = existing.find((label) => labelsAreSimilar(label.leaf_name, leafName));
      if (alreadyStored) {
        created.push(alreadyStored);
        continue;
      }
      const parentId = requested[index]!.parentId ?? null;
      const parent = parentId ? await this.repository.labelForAccount(account.id, parentId) : null;
      const depth = (parent?.depth ?? 0) + 1;
      if (depth > TAXONOMY_LIMITS.maxDepth) {
        throw new AppError(
          'LABEL_NAME_INVALID',
          `Folders nest at most ${TAXONOMY_LIMITS.maxDepth} levels deep.`,
          400,
        );
      }
      created.push(
        await this.repository.createLabel({
          accountId: account.id,
          name: leafName,
          treePath: parent ? `${treePathOf(parent)}/${leafName}` : leafName,
          depth,
          parentId: parent?.id ?? null,
          source: requested[index]!.source,
        }),
      );
    }

    for (const label of created) {
      if (label.gmail_label_id) continue;
      const remote = await this.gmail.ensureLabel(account.id, label.full_path);
      await this.repository.setGmailLabelId(label.id, remote.id);
    }
    await auditService.record({
      userId,
      action: 'labels.confirmed',
      result: 'SUCCESS',
      metadata: { labels: created.length },
    });
    return this.list(userId);
  }

  async rename(userId: string, id: string, leafName: string) {
    const account = await this.repository.activeAccountForUser(userId);
    const label = await this.repository.labelForAccount(account.id, id);
    const safeName = this.safeLeafName(leafName);
    const others = (await this.repository.approvedLabels(account.id)).filter(
      (candidate) => candidate.id !== label.id,
    );
    if (others.some((candidate) => labelsAreSimilar(candidate.leaf_name, safeName))) {
      throw new AppError(
        'LABEL_DUPLICATE',
        `"${safeName}" is too similar to a label this account already has.`,
        409,
      );
    }
    // Renaming a folder moves every Gmail label beneath it, because a Gmail label's name is the
    // whole path. Remote work happens first so a failure leaves the stored tree untouched.
    const descendants = await this.repository.descendantsOf(label);
    const oldPath = label.full_path;
    const newPath = `${oldPath.slice(0, oldPath.lastIndexOf('/'))}/${safeName}`;
    for (const affected of [label, ...descendants]) {
      if (!affected.gmail_label_id) continue;
      await this.gmail.renameLabel(
        account.id,
        affected.gmail_label_id,
        `${newPath}${affected.full_path.slice(oldPath.length)}`,
      );
    }
    const [updated] = await this.repository.renameLabel(label, safeName);
    await auditService.record({
      userId,
      action: 'labels.renamed',
      result: 'SUCCESS',
      metadata: { labelId: label.id, descendants: descendants.length },
    });
    return this.serialize(updated!, descendants.length === 0);
  }

  /** Removes MailMind's record of the folder. The Gmail label and its mail are left alone. */
  async remove(userId: string, id: string) {
    const account = await this.repository.activeAccountForUser(userId);
    const label = await this.repository.labelForAccount(account.id, id);
    const descendants = await this.repository.descendantsOf(label);
    await this.repository.deleteLabel(label.id);
    await auditService.record({
      userId,
      action: 'labels.deleted',
      result: 'SUCCESS',
      metadata: { labelId: label.id, descendants: descendants.length },
    });
    return {
      success: true,
      gmailLabelRetained: [label, ...descendants].some((row) => Boolean(row.gmail_label_id)),
      removedDescendants: descendants.length,
    };
  }

  /** Selected nodes plus every ancestor they need, shallowest first. */
  private selectedNodes(plan: PlanWithNodes, nodeIds: string[] | undefined): PlanNode[] {
    const byId = new Map(plan.nodes.map((node) => [node.id, node]));
    if (!nodeIds || nodeIds.length === 0) return [...plan.nodes];
    const keep = new Set<string>();
    for (const nodeId of nodeIds) {
      let current = byId.get(nodeId);
      if (!current) {
        throw new AppError(
          'LABEL_PLAN_NODE_NOT_FOUND',
          'That folder is not part of the plan.',
          404,
        );
      }
      while (current) {
        keep.add(current.id);
        current = current.parent_id ? byId.get(current.parent_id) : undefined;
      }
    }
    return plan.nodes.filter((node) => keep.has(node.id));
  }

  private serialize(label: user_labels, isLeaf: boolean) {
    return {
      id: label.id,
      parentId: label.parent_id,
      depth: label.depth,
      leafName: label.leaf_name,
      fullPath: label.full_path,
      path: treePathOf(label),
      isLeaf,
      rationale: label.rationale,
      source: label.source,
      gmailLabelId: label.gmail_label_id,
      createdAt: label.created_at.toISOString(),
    };
  }

  private serializePlan(plan: PlanWithNodes) {
    const rolled = new Map<string, number>();
    // Counts roll up so a parent shows the mail its whole subtree would receive.
    for (const node of [...plan.nodes].sort((left, right) => right.depth - left.depth)) {
      const own = node.matched_message_count + (rolled.get(node.id) ?? 0);
      rolled.set(node.id, own);
      if (node.parent_id) rolled.set(node.parent_id, (rolled.get(node.parent_id) ?? 0) + own);
    }
    return {
      id: plan.id,
      status: plan.status,
      model: plan.model,
      promptVersion: plan.prompt_version,
      sampledMessageCount: plan.sampled_message_count,
      analyzedMessageCount: plan.analyzed_message_count,
      leafCount: plan.leaf_count,
      warnings: plan.warnings,
      createdAt: plan.created_at.toISOString(),
      nodes: plan.nodes.map((node) => ({
        id: node.id,
        parentId: node.parent_id,
        depth: node.depth,
        kind: node.kind,
        name: node.name,
        fullPath: node.full_path,
        path: node.full_path.slice('MailMind/'.length),
        rationale: node.rationale,
        estimatedMessageCount: node.estimated_message_count,
        matchedMessageCount: node.matched_message_count,
        rolledUpMessageCount: rolled.get(node.id) ?? node.matched_message_count,
        isLeaf: node.is_leaf,
        gmailLabelPath: node.is_leaf
          ? labelPathFor(node.full_path.slice('MailMind/'.length))
          : null,
        rules: node.rules.map((rule) => ({
          kind: rule.rule_kind,
          value: rule.match_value,
          matchedMessageCount: rule.matched_message_count,
        })),
      })),
    };
  }
}

export const labelsService = new LabelsService();
