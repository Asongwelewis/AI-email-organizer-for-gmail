import { randomUUID } from 'node:crypto';
import type {
  classification_category,
  classification_source,
  classification_status,
  Prisma,
  recommended_action,
} from '@prisma/client';

import { env } from '@api/config/env.js';
import { prisma } from '@api/database/prisma.js';
import { AppError } from '@api/errors/AppError.js';

export interface ClassificationLease {
  accountId: string;
  token: string;
  runId: string;
}

export interface RunCounts {
  requested: number;
  processed: number;
  reused: number;
  rule: number;
  ai: number;
  providerCalls: number;
  review: number;
  failed: number;
  inputUnits?: number;
  outputUnits?: number;
}

export class ClassificationRepository {
  async activeAccountForUser(userId: string) {
    const account = await prisma.connected_google_accounts.findFirst({
      where: { user_id: userId, gmail_connected: true, connection_status: 'CONNECTED' },
      orderBy: { updated_at: 'desc' },
    });
    if (!account) {
      throw new AppError(
        'GMAIL_ACCOUNT_NOT_CONNECTED',
        'Connect Gmail before using classification.',
        409,
      );
    }
    return account;
  }

  async acquireLease(
    accountId: string,
    provider: string,
    model: string | null,
    classifierVersion: string,
  ): Promise<ClassificationLease> {
    await prisma.classification_states.upsert({
      where: { connected_google_account_id: accountId },
      create: { connected_google_account_id: accountId },
      update: {},
    });
    const now = new Date();
    const token = randomUUID();
    const acquired = await prisma.classification_states.updateMany({
      where: {
        connected_google_account_id: accountId,
        OR: [{ lease_expires_at: null }, { lease_expires_at: { lt: now } }],
      },
      data: {
        lease_token: token,
        lease_expires_at: new Date(now.getTime() + env.AI_CLASSIFICATION_LEASE_SECONDS * 1000),
        last_run_started_at: now,
        last_error_code: null,
      },
    });
    if (acquired.count !== 1) {
      throw new AppError(
        'CLASSIFICATION_ALREADY_RUNNING',
        'A classification run is already active for this Gmail account.',
        409,
      );
    }
    await prisma.classification_runs.updateMany({
      where: { connected_google_account_id: accountId, status: 'RUNNING' },
      data: {
        status: 'FAILED',
        completed_at: now,
        last_error_code: 'STALE_CLASSIFICATION_LEASE_RECOVERED',
      },
    });
    const run = await prisma.classification_runs.create({
      data: {
        connected_google_account_id: accountId,
        provider,
        model,
        classifier_version: classifierVersion,
      },
    });
    await prisma.classification_states.updateMany({
      where: { connected_google_account_id: accountId, lease_token: token },
      data: { active_run_id: run.id },
    });
    return { accountId, token, runId: run.id };
  }

  async renewLease(lease: ClassificationLease): Promise<void> {
    const result = await prisma.classification_states.updateMany({
      where: {
        connected_google_account_id: lease.accountId,
        lease_token: lease.token,
        lease_expires_at: { gt: new Date() },
      },
      data: {
        lease_expires_at: new Date(Date.now() + env.AI_CLASSIFICATION_LEASE_SECONDS * 1000),
      },
    });
    if (result.count !== 1) {
      throw new AppError(
        'CLASSIFICATION_ALREADY_RUNNING',
        'The classification lease expired or was replaced.',
        409,
      );
    }
  }

  async finish(lease: ClassificationLease, counts: RunCounts): Promise<void> {
    const now = new Date();
    await prisma.$transaction(async (transaction) => {
      const released = await transaction.classification_states.updateMany({
        where: { connected_google_account_id: lease.accountId, lease_token: lease.token },
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
          'CLASSIFICATION_ALREADY_RUNNING',
          'The classification lease expired or was replaced.',
          409,
        );
      }
      await transaction.classification_runs.update({
        where: { id: lease.runId },
        data: this.runData(counts, 'COMPLETED', now),
      });
    });
  }

  async fail(lease: ClassificationLease, counts: RunCounts, code: string): Promise<void> {
    const now = new Date();
    await prisma.$transaction([
      prisma.classification_states.updateMany({
        where: { connected_google_account_id: lease.accountId, lease_token: lease.token },
        data: {
          lease_token: null,
          lease_expires_at: null,
          active_run_id: null,
          last_run_completed_at: now,
          last_error_code: code,
        },
      }),
      prisma.classification_runs.update({
        where: { id: lease.runId },
        data: { ...this.runData(counts, 'FAILED', now), last_error_code: code },
      }),
    ]);
  }

  private runData(
    counts: RunCounts,
    status: 'COMPLETED' | 'FAILED',
    completedAt: Date,
  ): Prisma.classification_runsUpdateInput {
    return {
      status,
      completed_at: completedAt,
      requested_message_count: counts.requested,
      processed_message_count: counts.processed,
      reused_result_count: counts.reused,
      rule_classified_count: counts.rule,
      ai_classified_count: counts.ai,
      provider_call_count: counts.providerCalls,
      review_required_count: counts.review,
      failed_count: counts.failed,
      ...(counts.inputUnits === undefined ? {} : { input_units: counts.inputUnits }),
      ...(counts.outputUnits === undefined ? {} : { output_units: counts.outputUnits }),
    };
  }

  eligibleMessages(accountId: string, limit: number, messageRecordId?: string) {
    return prisma.gmail_message_metadata.findMany({
      where: {
        connected_google_account_id: accountId,
        deleted_at: null,
        is_draft: false,
        is_trashed: false,
        NOT: { label_ids: { hasSome: ['SPAM', 'TRASH', 'DRAFT'] } },
        ...(messageRecordId ? { id: messageRecordId } : {}),
      },
      orderBy: [{ internal_date: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  }

  findReusable(
    messageId: string,
    classifierVersion: string,
    promptVersion: string,
    taxonomyVersion: string,
    metadataHash: string,
  ) {
    return prisma.classification_results.findFirst({
      where: {
        gmail_message_id: messageId,
        classifier_version: classifierVersion,
        prompt_version: promptVersion,
        taxonomy_version: taxonomyVersion,
        message_metadata_hash: metadataHash,
        status: { in: ['COMPLETED', 'NEEDS_REVIEW'] },
      },
      orderBy: { classified_at: 'desc' },
    });
  }

  async storeResult(data: {
    accountId: string;
    messageId: string;
    category: classification_category;
    recommendedAction: recommended_action;
    confidence: number;
    requiresReview: boolean;
    explanation: string;
    reasonCodes: string[];
    source: classification_source;
    classifierVersion: string;
    promptVersion: string;
    taxonomyVersion: string;
    provider: string;
    model: string | null;
    inputHash: string;
    metadataHash: string;
    status: classification_status;
  }) {
    return prisma.$transaction(async (transaction) => {
      await transaction.classification_results.updateMany({
        where: {
          gmail_message_id: data.messageId,
          status: { in: ['PENDING', 'COMPLETED', 'NEEDS_REVIEW'] },
        },
        data: { status: 'SUPERSEDED' },
      });
      return transaction.classification_results.create({
        data: {
          connected_google_account_id: data.accountId,
          gmail_message_id: data.messageId,
          category: data.category,
          recommended_action: data.recommendedAction,
          confidence: data.confidence,
          requires_review: data.requiresReview,
          explanation: data.explanation,
          reason_codes: data.reasonCodes,
          source: data.source,
          classifier_version: data.classifierVersion,
          prompt_version: data.promptVersion,
          taxonomy_version: data.taxonomyVersion,
          provider: data.provider,
          model: data.model,
          input_hash: data.inputHash,
          message_metadata_hash: data.metadataHash,
          status: data.status,
        },
      });
    });
  }

  async status(accountId: string) {
    const [state, latestRun, classifiedCount, reviewCount, categoryGroups, actionGroups] =
      await Promise.all([
        prisma.classification_states.findUnique({
          where: { connected_google_account_id: accountId },
        }),
        prisma.classification_runs.findFirst({
          where: { connected_google_account_id: accountId },
          orderBy: { started_at: 'desc' },
        }),
        prisma.classification_results.count({
          where: {
            connected_google_account_id: accountId,
            status: { in: ['COMPLETED', 'NEEDS_REVIEW'] },
          },
        }),
        prisma.classification_results.count({
          where: {
            connected_google_account_id: accountId,
            status: 'NEEDS_REVIEW',
          },
        }),
        prisma.classification_results.groupBy({
          by: ['category'],
          where: {
            connected_google_account_id: accountId,
            status: { in: ['COMPLETED', 'NEEDS_REVIEW'] },
          },
          _count: true,
        }),
        prisma.classification_results.groupBy({
          by: ['recommended_action'],
          where: {
            connected_google_account_id: accountId,
            status: { in: ['COMPLETED', 'NEEDS_REVIEW'] },
          },
          _count: true,
        }),
      ]);
    return { state, latestRun, classifiedCount, reviewCount, categoryGroups, actionGroups };
  }

  listResults(
    accountId: string,
    options: {
      category?: classification_category | undefined;
      recommendedAction?: recommended_action | undefined;
      requiresReview?: boolean | undefined;
      status?: classification_status | undefined;
      cursor?: string | undefined;
      limit: number;
    },
  ) {
    return prisma.classification_results.findMany({
      where: {
        connected_google_account_id: accountId,
        status: options.status ?? { in: ['COMPLETED', 'NEEDS_REVIEW'] },
        ...(options.category ? { category: options.category } : {}),
        ...(options.recommendedAction ? { recommended_action: options.recommendedAction } : {}),
        ...(options.requiresReview === undefined
          ? {}
          : { requires_review: options.requiresReview }),
      },
      include: {
        gmail_message_metadata: {
          select: {
            subject: true,
            sender_name: true,
            sender_email: true,
            snippet: true,
            label_ids: true,
            internal_date: true,
          },
        },
        corrections: { orderBy: { created_at: 'desc' }, take: 1 },
      },
      orderBy: { id: 'desc' },
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      take: options.limit + 1,
    });
  }

  resultForUser(id: string, accountId: string) {
    return prisma.classification_results.findFirst({
      where: { id, connected_google_account_id: accountId },
      include: {
        gmail_message_metadata: true,
        corrections: { orderBy: { created_at: 'desc' } },
      },
    });
  }

  async correct(
    resultId: string,
    accountId: string,
    userId: string,
    correctedCategory: classification_category,
    correctedAction: recommended_action,
    feedbackReason?: string,
  ) {
    const result = await prisma.classification_results.findFirst({
      where: { id: resultId, connected_google_account_id: accountId },
    });
    if (!result) {
      throw new AppError(
        'CLASSIFICATION_RESULT_NOT_FOUND',
        'Classification recommendation not found.',
        404,
      );
    }
    return prisma.user_classification_corrections.create({
      data: {
        classification_result_id: result.id,
        gmail_message_id: result.gmail_message_id,
        connected_google_account_id: accountId,
        user_id: userId,
        original_category: result.category,
        corrected_category: correctedCategory,
        original_recommended_action: result.recommended_action,
        corrected_recommended_action: correctedAction,
        ...(feedbackReason === undefined ? {} : { feedback_reason: feedbackReason }),
      },
    });
  }
}

export const classificationRepository = new ClassificationRepository();
