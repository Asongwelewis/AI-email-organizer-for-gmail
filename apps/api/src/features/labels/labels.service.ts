import type { user_label_source, user_labels } from '@prisma/client';

import { auditService } from '@api/audit/audit.service.js';
import { env } from '@api/config/env.js';
import { logger } from '@api/config/logger.js';
import { AppError } from '@api/errors/AppError.js';
import {
  automationGmailService,
  type AutomationGmailService,
} from '@api/features/automation/automation-gmail.service.js';
import { discoverDeterministicCandidates } from '@api/features/label-discovery/label-discovery.engine.js';
import { LABEL_CANDIDATE_TYPES } from '@api/features/label-discovery/label-discovery.taxonomy.js';
import type {
  DiscoveryMessage,
  DiscoveryPreferences,
} from '@api/features/label-discovery/label-discovery.types.js';
import {
  isGenericLabelName,
  labelsAreSimilar,
  validateLeafName,
} from '@api/features/label-discovery/label-normalization.js';
import { labelPathFor, labelsRepository, type LabelsRepository } from './labels.repository.js';

export interface ConfirmLabelInput {
  leafName: string;
  source: user_label_source;
}

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
    const [labels, proposals] = await Promise.all([
      this.repository.approvedLabels(account.id),
      this.repository.pendingProposals(account.id),
    ]);
    return {
      maxLabels: env.AUTOMATION_MAX_LABELS,
      labels: labels.map((label) => this.serialize(label)),
      proposals: proposals.map((proposal) => ({
        id: proposal.id,
        leafName: proposal.suggested_leaf_name,
        fullPath: proposal.suggested_full_path,
        confidence: proposal.confidence,
        messageCount: proposal.message_count,
        reasonCodes: proposal.reason_codes,
      })),
    };
  }

  async propose(userId: string) {
    const account = await this.repository.activeAccountForUser(userId);
    const approved = await this.repository.approvedLabels(account.id);
    if (approved.length >= env.AUTOMATION_MAX_LABELS) {
      throw new AppError(
        'LABEL_LIMIT_REACHED',
        `This account already has the maximum of ${env.AUTOMATION_MAX_LABELS} labels.`,
        409,
      );
    }
    const lease = await this.repository.acquireProposalLease(account.id);
    try {
      const preferences: DiscoveryPreferences = {
        minMessages: env.DYNAMIC_LABEL_MIN_MESSAGES,
        lookbackDays: env.DYNAMIC_LABEL_LOOKBACK_DAYS,
        maxCandidates: Math.max(1, env.AUTOMATION_MAX_LABELS - approved.length),
        allowedCandidateTypes: [...LABEL_CANDIDATE_TYPES],
        preferOrganizations: true,
        preferTopics: true,
      };
      const [records, gmailLabelNames] = await Promise.all([
        this.repository.eligibleMessages(
          account.id,
          preferences.lookbackDays,
          env.DYNAMIC_LABEL_MAX_MESSAGES_PER_RUN,
        ),
        this.repository.existingGmailLabelNames(account.id),
      ]);
      if (records.length < preferences.minMessages) {
        throw new AppError(
          'LABEL_PROPOSAL_NOT_ENOUGH_MAIL',
          'Synchronize more mail before proposing labels.',
          422,
        );
      }
      const messages: DiscoveryMessage[] = records.map((message) => ({
        id: message.id,
        gmailThreadId: message.gmail_thread_id,
        internalDate: message.internal_date,
        subject: message.subject,
        senderName: message.sender_name,
        senderEmail: message.sender_email,
        gmailLabels: message.label_ids,
        category: null,
        correctedCategory: null,
      }));
      const discovery = discoverDeterministicCandidates(messages, preferences, {
        minCategoryAgreement: env.DYNAMIC_LABEL_MIN_CATEGORY_AGREEMENT,
        minSourceAgreement: env.DYNAMIC_LABEL_MIN_SOURCE_AGREEMENT,
        minimumConfidence: env.DYNAMIC_LABEL_MIN_CONFIDENCE,
        existingLabelNames: gmailLabelNames,
      });

      await this.repository.clearPendingProposals(account.id);
      const accepted: string[] = [];
      const room = env.AUTOMATION_MAX_LABELS - approved.length;
      for (const group of discovery.groups) {
        if (accepted.length >= room) break;
        let leafName: string;
        try {
          leafName = this.safeLeafName(group.suggestedLeafName);
        } catch {
          continue;
        }
        const clashes = [...approved.map((label) => label.leaf_name), ...accepted].some(
          (existing) => labelsAreSimilar(existing, leafName),
        );
        if (clashes) continue;
        await this.repository.storeProposal(account.id, group, leafName);
        accepted.push(leafName);
      }
      logger.info(
        { accountId: account.id, groups: discovery.groups.length, proposals: accepted.length },
        'label proposal completed',
      );
      await auditService.record({
        userId,
        action: 'labels.proposed',
        result: 'SUCCESS',
        metadata: { proposals: accepted.length, analyzed: records.length },
      });
      return this.list(userId);
    } finally {
      await this.repository.releaseProposalLease(lease);
    }
  }

  async confirm(userId: string, requested: ConfirmLabelInput[]) {
    const account = await this.repository.activeAccountForUser(userId);
    if (requested.length === 0) {
      throw new AppError('LABEL_SET_EMPTY', 'Confirm at least one label.', 400);
    }
    if (requested.length > env.AUTOMATION_MAX_LABELS) {
      throw new AppError(
        'LABEL_LIMIT_REACHED',
        `Confirm at most ${env.AUTOMATION_MAX_LABELS} labels.`,
        409,
      );
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
      created.push(
        await this.repository.createLabel({
          accountId: account.id,
          leafName,
          source: requested[index]!.source,
        }),
      );
    }

    // Gmail work happens outside the database writes so a partial failure stays resumable.
    for (const label of created) {
      if (label.gmail_label_id) continue;
      const remote = await this.gmail.ensureLabel(account.id, label.full_path);
      await this.repository.setGmailLabelId(label.id, remote.id);
    }
    await this.repository.markProposalsApproved(account.id, names);
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
    if (label.gmail_label_id) {
      await this.gmail.renameLabel(account.id, label.gmail_label_id, labelPathFor(safeName));
    }
    const updated = await this.repository.renameLabel(label.id, safeName);
    await auditService.record({
      userId,
      action: 'labels.renamed',
      result: 'SUCCESS',
      metadata: { labelId: label.id },
    });
    return this.serialize(updated);
  }

  /** Removes MailMind's record of the label. The Gmail label and its mail are left alone. */
  async remove(userId: string, id: string) {
    const account = await this.repository.activeAccountForUser(userId);
    const label = await this.repository.labelForAccount(account.id, id);
    await this.repository.deleteLabel(label.id);
    await auditService.record({
      userId,
      action: 'labels.deleted',
      result: 'SUCCESS',
      metadata: { labelId: label.id },
    });
    return { success: true, gmailLabelRetained: Boolean(label.gmail_label_id) };
  }

  private serialize(label: user_labels) {
    return {
      id: label.id,
      leafName: label.leaf_name,
      fullPath: label.full_path,
      source: label.source,
      gmailLabelId: label.gmail_label_id,
      createdAt: label.created_at.toISOString(),
    };
  }
}

export const labelsService = new LabelsService();
