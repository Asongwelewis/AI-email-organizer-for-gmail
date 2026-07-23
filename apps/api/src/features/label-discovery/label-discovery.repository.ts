import { randomUUID } from 'node:crypto';
import type {
  dynamic_label_candidate_status,
  label_candidate_decision,
  Prisma,
} from '@prisma/client';

import { env } from '@api/config/env.js';
import { prisma } from '@api/database/prisma.js';
import { AppError } from '@api/errors/AppError.js';
import type { CandidateGroup } from './label-discovery.types.js';
import { buildControlledLabelPath, normalizeLabelForComparison } from './label-normalization.js';
import { LABEL_DISCOVERY_VERSION, LABEL_NAMING_VERSION } from './label-discovery.taxonomy.js';

const LEASE_MILLISECONDS = 300_000;

export interface LabelDiscoveryLease {
  accountId: string;
  token: string;
  runId: string;
}

export interface DiscoveryRunCounts {
  messagesAnalyzed: number;
  groupsDiscovered: number;
  candidatesCreated: number;
  candidatesReused: number;
  candidatesRejectedByRules: number;
  providerCalls: number;
}

export class LabelDiscoveryRepository {
  async activeAccountForUser(userId: string) {
    const account = await prisma.connected_google_accounts.findFirst({
      where: { user_id: userId, gmail_connected: true, connection_status: 'CONNECTED' },
      orderBy: { updated_at: 'desc' },
    });
    if (!account) {
      throw new AppError(
        'GMAIL_ACCOUNT_NOT_CONNECTED',
        'Connect Gmail before discovering labels.',
        409,
      );
    }
    return account;
  }

  async acquireLease(accountId: string): Promise<LabelDiscoveryLease> {
    await prisma.label_discovery_states.upsert({
      where: { connected_google_account_id: accountId },
      create: { connected_google_account_id: accountId },
      update: {},
    });
    const now = new Date();
    const token = randomUUID();
    const acquired = await prisma.label_discovery_states.updateMany({
      where: {
        connected_google_account_id: accountId,
        OR: [{ lease_expires_at: null }, { lease_expires_at: { lt: now } }],
      },
      data: {
        lease_token: token,
        lease_expires_at: new Date(now.getTime() + LEASE_MILLISECONDS),
        last_run_started_at: now,
        last_error_code: null,
      },
    });
    if (acquired.count !== 1) {
      throw new AppError(
        'LABEL_DISCOVERY_ALREADY_RUNNING',
        'A label-discovery run is already active for this Gmail account.',
        409,
      );
    }
    await prisma.label_discovery_runs.updateMany({
      where: { connected_google_account_id: accountId, status: 'RUNNING' },
      data: {
        status: 'FAILED',
        completed_at: now,
        last_error_code: 'STALE_LABEL_DISCOVERY_LEASE_RECOVERED',
      },
    });
    const run = await prisma.label_discovery_runs.create({
      data: { connected_google_account_id: accountId },
    });
    await prisma.label_discovery_states.updateMany({
      where: { connected_google_account_id: accountId, lease_token: token },
      data: { active_run_id: run.id },
    });
    return { accountId, token, runId: run.id };
  }

  async finish(lease: LabelDiscoveryLease, counts: DiscoveryRunCounts): Promise<void> {
    const now = new Date();
    await prisma.$transaction(async (transaction) => {
      const released = await transaction.label_discovery_states.updateMany({
        where: {
          connected_google_account_id: lease.accountId,
          lease_token: lease.token,
        },
        data: {
          lease_token: null,
          lease_expires_at: null,
          active_run_id: null,
          last_run_completed_at: now,
          last_error_code: null,
        },
      });
      if (released.count !== 1) {
        throw new AppError(
          'LABEL_DISCOVERY_ALREADY_RUNNING',
          'The label-discovery lease expired or was replaced.',
          409,
        );
      }
      await transaction.label_discovery_runs.update({
        where: { id: lease.runId },
        data: {
          status: 'COMPLETED',
          completed_at: now,
          ...this.runData(counts),
        },
      });
    });
  }

  async fail(
    lease: LabelDiscoveryLease,
    counts: DiscoveryRunCounts,
    errorCode: string,
  ): Promise<void> {
    const now = new Date();
    await prisma.$transaction([
      prisma.label_discovery_states.updateMany({
        where: {
          connected_google_account_id: lease.accountId,
          lease_token: lease.token,
        },
        data: {
          lease_token: null,
          lease_expires_at: null,
          active_run_id: null,
          last_run_completed_at: now,
          last_error_code: errorCode,
        },
      }),
      prisma.label_discovery_runs.update({
        where: { id: lease.runId },
        data: {
          status: 'FAILED',
          completed_at: now,
          last_error_code: errorCode,
          ...this.runData(counts),
        },
      }),
    ]);
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
      include: {
        classificationResults: {
          where: { status: { in: ['COMPLETED', 'NEEDS_REVIEW'] } },
          orderBy: { classified_at: 'desc' },
          take: 1,
          include: { corrections: { orderBy: { created_at: 'desc' }, take: 1 } },
        },
      },
      orderBy: [{ internal_date: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  }

  existingLabelNames(accountId: string) {
    return prisma.gmail_labels.findMany({
      where: { connected_google_account_id: accountId },
      select: { name: true },
    });
  }

  async storeCandidate(accountId: string, group: CandidateGroup) {
    const path = buildControlledLabelPath(group.candidateType, group.suggestedLeafName);
    const normalizedName = normalizeLabelForComparison(group.suggestedLeafName);
    const existing =
      (await prisma.dynamic_label_candidates.findUnique({
        where: {
          connected_google_account_id_input_hash: {
            connected_google_account_id: accountId,
            input_hash: group.inputHash,
          },
        },
      })) ??
      (await prisma.dynamic_label_candidates.findFirst({
        where: {
          connected_google_account_id: accountId,
          suggested_full_path: { equals: path, mode: 'insensitive' },
          status: { in: ['PENDING', 'APPROVED', 'DEFERRED', 'CREATED'] },
        },
      }));
    if (existing?.status === 'REJECTED') {
      const cooldownEnds =
        existing.last_discovered_at.getTime() +
        env.DYNAMIC_LABEL_REDISCOVERY_DAYS * 24 * 60 * 60 * 1000;
      const materiallyChanged =
        group.messageCount >= existing.message_count + env.DYNAMIC_LABEL_MIN_MESSAGES;
      if (Date.now() < cooldownEnds || !materiallyChanged) {
        return { candidate: existing, created: false, suppressed: true };
      }
    }
    if (existing && ['MERGED', 'SUPERSEDED', 'FAILED'].includes(existing.status)) {
      return { candidate: existing, created: false, suppressed: true };
    }
    const status: dynamic_label_candidate_status =
      existing?.status === 'REJECTED' ? 'PENDING' : (existing?.status ?? 'PENDING');
    const candidate = await prisma.$transaction(async (transaction) => {
      const record = existing
        ? await transaction.dynamic_label_candidates.update({
            where: { id: existing.id },
            data: {
              candidate_type: group.candidateType,
              source_key: group.sourceKey,
              suggested_leaf_name: group.suggestedLeafName,
              suggested_full_path: path,
              normalized_name: normalizedName,
              status,
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
              input_hash: group.inputHash,
              last_discovered_at: new Date(),
            },
          })
        : await transaction.dynamic_label_candidates.create({
            data: {
              connected_google_account_id: accountId,
              candidate_type: group.candidateType,
              source_key: group.sourceKey,
              suggested_leaf_name: group.suggestedLeafName,
              suggested_full_path: path,
              normalized_name: normalizedName,
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
              input_hash: group.inputHash,
            },
          });
      await transaction.dynamic_label_candidate_messages.deleteMany({
        where: { candidate_id: record.id },
      });
      await transaction.dynamic_label_candidate_messages.createMany({
        data: group.messageIds.map((messageId) => ({
          candidate_id: record.id,
          gmail_message_id: messageId,
          association_score: group.confidence,
          reason_codes: group.reasonCodes,
        })),
        skipDuplicates: true,
      });
      return record;
    });
    return { candidate, created: !existing, suppressed: false };
  }

  async status(accountId: string) {
    const [state, latestRun, pendingCount, approvedCount] = await Promise.all([
      prisma.label_discovery_states.findUnique({
        where: { connected_google_account_id: accountId },
      }),
      prisma.label_discovery_runs.findFirst({
        where: { connected_google_account_id: accountId },
        orderBy: { started_at: 'desc' },
      }),
      prisma.dynamic_label_candidates.count({
        where: {
          connected_google_account_id: accountId,
          status: { in: ['PENDING', 'DEFERRED'] },
        },
      }),
      prisma.dynamic_label_candidates.count({
        where: {
          connected_google_account_id: accountId,
          status: { in: ['APPROVED', 'CREATED'] },
        },
      }),
    ]);
    return { state, latestRun, pendingCount, approvedCount };
  }

  list(
    accountId: string,
    options: {
      status?: dynamic_label_candidate_status | undefined;
      candidateType?: CandidateGroup['candidateType'] | undefined;
      cursor?: string | undefined;
      limit: number;
    },
  ) {
    return prisma.dynamic_label_candidates.findMany({
      where: {
        connected_google_account_id: accountId,
        ...(options.status ? { status: options.status } : {}),
        ...(options.candidateType ? { candidate_type: options.candidateType } : {}),
      },
      include: {
        decisions: { orderBy: { created_at: 'desc' }, take: 1 },
        merged_into_candidate: { select: { id: true, suggested_full_path: true } },
      },
      orderBy: [{ last_discovered_at: 'desc' }, { id: 'desc' }],
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      take: options.limit + 1,
    });
  }

  candidate(accountId: string, id: string) {
    return prisma.dynamic_label_candidates.findFirst({
      where: { id, connected_google_account_id: accountId },
      include: {
        decisions: { orderBy: { created_at: 'desc' } },
        merged_into_candidate: { select: { id: true, suggested_full_path: true } },
      },
    });
  }

  equivalentApproved(accountId: string, normalizedName: string, excludeId: string) {
    return prisma.dynamic_label_candidates.findFirst({
      where: {
        connected_google_account_id: accountId,
        normalized_name: normalizedName,
        status: { in: ['APPROVED', 'CREATED'] },
        id: { not: excludeId },
      },
    });
  }

  gmailLabelByNormalizedName(accountId: string, normalizedName: string) {
    return prisma.gmail_labels
      .findMany({
        where: { connected_google_account_id: accountId },
        select: { id: true, name: true },
      })
      .then((labels) =>
        labels.find((label) => normalizeLabelForComparison(label.name) === normalizedName),
      );
  }

  async decide(input: {
    accountId: string;
    userId: string;
    candidateId: string;
    decision: label_candidate_decision;
    fromStatuses: dynamic_label_candidate_status[];
    toStatus: dynamic_label_candidate_status;
    finalLeafName?: string;
    finalFullPath?: string;
    decisionReason?: string;
  }) {
    return prisma.$transaction(async (transaction) => {
      const candidate = await transaction.dynamic_label_candidates.findFirst({
        where: {
          id: input.candidateId,
          connected_google_account_id: input.accountId,
        },
      });
      if (!candidate) {
        throw new AppError('LABEL_CANDIDATE_NOT_FOUND', 'Label candidate not found.', 404);
      }
      const changed = await transaction.dynamic_label_candidates.updateMany({
        where: { id: candidate.id, status: { in: input.fromStatuses } },
        data: {
          status: input.toStatus,
          ...(input.finalLeafName
            ? {
                suggested_leaf_name: input.finalLeafName,
                suggested_full_path: input.finalFullPath!,
                normalized_name: normalizeLabelForComparison(input.finalLeafName),
              }
            : {}),
        },
      });
      if (changed.count !== 1) {
        throw new AppError(
          'LABEL_CANDIDATE_NOT_ACTIVE',
          'The label candidate is no longer active for this decision.',
          409,
        );
      }
      const decision = await transaction.label_decisions.create({
        data: {
          candidate_id: candidate.id,
          user_id: input.userId,
          decision: input.decision,
          original_suggested_name: candidate.suggested_leaf_name,
          ...(input.finalLeafName === undefined ? {} : { final_leaf_name: input.finalLeafName }),
          ...(input.finalFullPath === undefined ? {} : { final_full_path: input.finalFullPath }),
          ...(input.decisionReason === undefined ? {} : { decision_reason: input.decisionReason }),
        },
      });
      return { candidate, decision };
    });
  }

  async merge(accountId: string, userId: string, sourceId: string, targetId: string) {
    if (sourceId === targetId) {
      throw new AppError(
        'LABEL_CANDIDATE_MERGE_CYCLE',
        'A label candidate cannot be merged into itself.',
        409,
      );
    }
    return prisma.$transaction(async (transaction) => {
      const candidates = await transaction.dynamic_label_candidates.findMany({
        where: { id: { in: [sourceId, targetId] }, connected_google_account_id: accountId },
        include: { messages: true },
      });
      const source = candidates.find((candidate) => candidate.id === sourceId);
      const target = candidates.find((candidate) => candidate.id === targetId);
      if (!source || !target) {
        throw new AppError(
          'LABEL_CANDIDATE_MERGE_CONFLICT',
          'Both label candidates must belong to the connected Gmail account.',
          409,
        );
      }
      if (
        !['PENDING', 'DEFERRED'].includes(source.status) ||
        ['REJECTED', 'MERGED', 'SUPERSEDED', 'FAILED'].includes(target.status)
      ) {
        throw new AppError(
          'LABEL_CANDIDATE_MERGE_CONFLICT',
          'The selected label candidates cannot be merged.',
          409,
        );
      }
      let cursor = target;
      const visited = new Set([source.id]);
      while (cursor.merged_into_candidate_id) {
        if (visited.has(cursor.merged_into_candidate_id)) {
          throw new AppError('LABEL_CANDIDATE_MERGE_CYCLE', 'The merge would create a cycle.', 409);
        }
        visited.add(cursor.merged_into_candidate_id);
        const next = await transaction.dynamic_label_candidates.findFirst({
          where: { id: cursor.merged_into_candidate_id, connected_google_account_id: accountId },
          include: { messages: true },
        });
        if (!next) break;
        cursor = next;
      }
      await transaction.dynamic_label_candidate_messages.createMany({
        data: source.messages.map((association) => ({
          candidate_id: target.id,
          gmail_message_id: association.gmail_message_id,
          association_score: Math.max(association.association_score, target.confidence),
          reason_codes: [...new Set([...association.reason_codes, ...target.reason_codes])],
        })),
        skipDuplicates: true,
      });
      const associations = await transaction.dynamic_label_candidate_messages.findMany({
        where: { candidate_id: target.id },
        include: { message: { select: { gmail_thread_id: true } } },
      });
      await transaction.dynamic_label_candidates.update({
        where: { id: target.id },
        data: {
          message_count: associations.length,
          thread_count: new Set(
            associations.map(
              (association) => association.message.gmail_thread_id ?? association.gmail_message_id,
            ),
          ).size,
          confidence: Math.max(source.confidence, target.confidence),
          reason_codes: [...new Set([...source.reason_codes, ...target.reason_codes])],
        },
      });
      const changed = await transaction.dynamic_label_candidates.updateMany({
        where: { id: source.id, status: { in: ['PENDING', 'DEFERRED'] } },
        data: { status: 'MERGED', merged_into_candidate_id: target.id },
      });
      if (changed.count !== 1) {
        throw new AppError(
          'LABEL_CANDIDATE_MERGE_CONFLICT',
          'The source label candidate changed before it could be merged.',
          409,
        );
      }
      await transaction.label_decisions.create({
        data: {
          candidate_id: source.id,
          user_id: userId,
          decision: 'MERGE',
          original_suggested_name: source.suggested_leaf_name,
          merged_into_candidate_id: target.id,
        },
      });
      return target;
    });
  }

  private runData(counts: DiscoveryRunCounts): Prisma.label_discovery_runsUpdateInput {
    return {
      messages_analyzed: counts.messagesAnalyzed,
      groups_discovered: counts.groupsDiscovered,
      candidates_created: counts.candidatesCreated,
      candidates_reused: counts.candidatesReused,
      candidates_rejected_by_rules: counts.candidatesRejectedByRules,
      provider_calls: counts.providerCalls,
    };
  }
}

export const labelDiscoveryRepository = new LabelDiscoveryRepository();
