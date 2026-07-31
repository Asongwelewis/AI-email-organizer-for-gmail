import { randomUUID } from 'node:crypto';
import type { user_label_source, user_labels } from '@prisma/client';

import { env } from '@api/config/env.js';
import { prisma } from '@api/database/prisma.js';
import { AppError } from '@api/errors/AppError.js';
import { normalizeLabelForComparison } from '@api/features/label-discovery/label-normalization.js';
import type { CandidateGroup } from '@api/features/label-discovery/label-discovery.types.js';
import {
  LABEL_DISCOVERY_VERSION,
  LABEL_NAMING_VERSION,
} from '@api/features/label-discovery/label-discovery.taxonomy.js';

const PROPOSAL_LEASE_SECONDS = 120;

export interface ProposalLease {
  accountId: string;
  token: string;
}

export function labelPathFor(leafName: string): string {
  return `MailMind/${leafName}`;
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

  eligibleMessages(accountId: string, lookbackDays: number, limit: number) {
    return prisma.gmail_message_metadata.findMany({
      where: {
        connected_google_account_id: accountId,
        deleted_at: null,
        is_draft: false,
        is_trashed: false,
        internal_date: { gte: new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000) },
        sender_email: { not: null },
        NOT: { label_ids: { hasSome: ['SPAM', 'TRASH', 'DRAFT'] } },
      },
      orderBy: [{ internal_date: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  }

  async existingGmailLabelNames(accountId: string): Promise<string[]> {
    const labels = await prisma.gmail_labels.findMany({
      where: { connected_google_account_id: accountId },
      select: { name: true },
    });
    return labels.map((label) => label.name);
  }

  approvedLabels(accountId: string) {
    return prisma.user_labels.findMany({
      where: { connected_google_account_id: accountId },
      orderBy: { created_at: 'asc' },
    });
  }

  approvedLabelByLeaf(accountId: string, leafName: string) {
    return prisma.user_labels.findUnique({
      where: {
        connected_google_account_id_normalized_name: {
          connected_google_account_id: accountId,
          normalized_name: normalizeLabelForComparison(leafName),
        },
      },
    });
  }

  pendingProposals(accountId: string) {
    return prisma.dynamic_label_candidates.findMany({
      where: { connected_google_account_id: accountId, status: 'PENDING' },
      orderBy: [{ confidence: 'desc' }, { message_count: 'desc' }],
      take: env.AUTOMATION_MAX_LABELS,
    });
  }

  async clearPendingProposals(accountId: string): Promise<void> {
    await prisma.dynamic_label_candidates.updateMany({
      where: { connected_google_account_id: accountId, status: 'PENDING' },
      data: { status: 'SUPERSEDED' },
    });
  }

  async storeProposal(accountId: string, group: CandidateGroup, leafName: string) {
    const fullPath = labelPathFor(leafName);
    const normalized = normalizeLabelForComparison(leafName);
    const existing = await prisma.dynamic_label_candidates.findUnique({
      where: {
        connected_google_account_id_input_hash: {
          connected_google_account_id: accountId,
          input_hash: group.inputHash,
        },
      },
    });
    const data = {
      candidate_type: group.candidateType,
      source_key: group.sourceKey,
      suggested_leaf_name: leafName,
      suggested_full_path: fullPath,
      normalized_name: normalized,
      status: 'PENDING' as const,
      confidence: group.confidence,
      message_count: group.messageCount,
      thread_count: group.threadCount,
      first_message_at: group.firstMessageAt,
      last_message_at: group.lastMessageAt,
      dominant_category: group.dominantCategory,
      category_agreement: group.categoryAgreement,
      source_agreement: group.sourceAgreement,
      reason_codes: group.reasonCodes,
      discovery_version: LABEL_DISCOVERY_VERSION,
      naming_version: LABEL_NAMING_VERSION,
      last_discovered_at: new Date(),
    };
    const candidate = existing
      ? await prisma.dynamic_label_candidates.update({ where: { id: existing.id }, data })
      : await prisma.dynamic_label_candidates.create({
          data: { ...data, connected_google_account_id: accountId, input_hash: group.inputHash },
        });
    await prisma.dynamic_label_candidate_messages.deleteMany({
      where: { candidate_id: candidate.id },
    });
    await prisma.dynamic_label_candidate_messages.createMany({
      data: group.messageIds.map((messageId) => ({
        candidate_id: candidate.id,
        gmail_message_id: messageId,
        association_score: group.confidence,
        reason_codes: group.reasonCodes,
      })),
      skipDuplicates: true,
    });
    return { candidate, created: !existing };
  }

  createLabel(input: {
    accountId: string;
    leafName: string;
    source: user_label_source;
  }): Promise<user_labels> {
    return prisma.user_labels.create({
      data: {
        connected_google_account_id: input.accountId,
        leaf_name: input.leafName,
        full_path: labelPathFor(input.leafName),
        normalized_name: normalizeLabelForComparison(input.leafName),
        source: input.source,
      },
    });
  }

  setGmailLabelId(id: string, gmailLabelId: string): Promise<user_labels> {
    return prisma.user_labels.update({ where: { id }, data: { gmail_label_id: gmailLabelId } });
  }

  renameLabel(id: string, leafName: string): Promise<user_labels> {
    return prisma.user_labels.update({
      where: { id },
      data: {
        leaf_name: leafName,
        full_path: labelPathFor(leafName),
        normalized_name: normalizeLabelForComparison(leafName),
      },
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

  async markProposalsApproved(accountId: string, leafNames: string[]): Promise<void> {
    if (leafNames.length === 0) return;
    await prisma.dynamic_label_candidates.updateMany({
      where: {
        connected_google_account_id: accountId,
        normalized_name: { in: leafNames.map(normalizeLabelForComparison) },
        status: 'PENDING',
      },
      data: { status: 'CREATED' },
    });
    await prisma.dynamic_label_candidates.updateMany({
      where: { connected_google_account_id: accountId, status: 'PENDING' },
      data: { status: 'REJECTED' },
    });
  }
}

export const labelsRepository = new LabelsRepository();
