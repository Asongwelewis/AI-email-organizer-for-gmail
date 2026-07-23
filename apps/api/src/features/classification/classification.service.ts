import type { classification_source, gmail_message_metadata } from '@prisma/client';

import { auditService } from '@api/audit/audit.service.js';
import { env } from '@api/config/env.js';
import { logger } from '@api/config/logger.js';
import { AppError } from '@api/errors/AppError.js';
import { hashClassificationInput, normalizeClassificationInput } from './classification-input.js';
import { buildClassificationPrompt } from './classification-prompts.js';
import { evaluateClassificationRules } from './classification-rules.js';
import {
  CLASSIFIER_VERSION,
  PROMPT_VERSION,
  TAXONOMY_VERSION,
  type ClassificationCategory,
  type RecommendedAction,
} from './classification-taxonomy.js';
import type {
  ClassificationOutput,
  EmailClassifierProvider,
  RuleSignal,
} from './classification.types.js';
import { validateClassificationOutput } from './classification.validation.js';
import { createClassifierProvider } from './providers/classifier-provider.js';
import {
  classificationRepository,
  type ClassificationLease,
  type RunCounts,
} from './repositories/classification.repository.js';
import { ClassificationError } from './classification.errors.js';

const emptyCounts = (): RunCounts => ({
  requested: 0,
  processed: 0,
  reused: 0,
  rule: 0,
  ai: 0,
  providerCalls: 0,
  review: 0,
  failed: 0,
});

export class ClassificationService {
  constructor(private readonly providerFactory = createClassifierProvider) {}

  async run(userId: string) {
    return this.execute(userId, undefined, false);
  }

  async reclassify(userId: string, messageId: string) {
    return this.execute(userId, messageId, true);
  }

  private async execute(userId: string, messageId?: string, force = false) {
    const account = await classificationRepository.activeAccountForUser(userId);
    const provider = this.providerFactory();
    const lease = await classificationRepository.acquireLease(
      account.id,
      provider.name,
      provider.model,
      CLASSIFIER_VERSION,
    );
    const counts = emptyCounts();
    const startedAt = Date.now();
    logger.info(
      {
        accountId: account.id,
        runId: lease.runId,
        provider: provider.name,
        model: provider.model,
        classifierVersion: CLASSIFIER_VERSION,
      },
      'classification run started',
    );
    try {
      const messages = await classificationRepository.eligibleMessages(
        account.id,
        messageId ? 1 : env.AI_CLASSIFICATION_MAX_MESSAGES_PER_RUN,
        messageId,
      );
      if (messageId && messages.length === 0) {
        throw new AppError(
          'CLASSIFICATION_NOT_ELIGIBLE',
          'The message was not found or is not eligible for classification.',
          404,
        );
      }
      counts.requested = messages.length;
      for (let index = 0; index < messages.length; index += 1) {
        if (index > 0 && index % env.AI_CLASSIFIER_BATCH_SIZE === 0) {
          await classificationRepository.renewLease(lease);
        }
        await this.processMessage(
          account.id,
          account.email,
          messages[index]!,
          provider,
          counts,
          force,
        );
      }
      await classificationRepository.finish(lease, counts);
      await auditService.record({
        userId,
        action: 'classification.run.completed',
        result: 'SUCCESS',
        metadata: {
          runId: lease.runId,
          processed: counts.processed,
          reviewRequired: counts.review,
          provider: provider.name,
        },
      });
      logger.info(
        {
          accountId: account.id,
          runId: lease.runId,
          ...counts,
          durationMs: Date.now() - startedAt,
          provider: provider.name,
          classifierVersion: CLASSIFIER_VERSION,
        },
        'classification run completed',
      );
      return this.runDto(lease, counts, provider);
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'CLASSIFICATION_FAILED';
      await classificationRepository.fail(lease, counts, code);
      logger.error(
        {
          accountId: account.id,
          runId: lease.runId,
          code,
          durationMs: Date.now() - startedAt,
        },
        'classification run failed',
      );
      throw error;
    }
  }

  private async processMessage(
    accountId: string,
    accountEmail: string,
    message: gmail_message_metadata,
    provider: EmailClassifierProvider,
    counts: RunCounts,
    force: boolean,
  ): Promise<void> {
    try {
      const input = normalizeClassificationInput(message, accountEmail);
      const metadataHash = hashClassificationInput(input);
      if (!force) {
        const existing = await classificationRepository.findReusable(
          message.id,
          CLASSIFIER_VERSION,
          PROMPT_VERSION,
          TAXONOMY_VERSION,
          metadataHash,
        );
        if (existing) {
          counts.reused += 1;
          counts.processed += 1;
          if (existing.requires_review) counts.review += 1;
          return;
        }
      }
      const rules = evaluateClassificationRules(input).sort(
        (left, right) => right.confidence - left.confidence,
      );
      const strongest = rules[0];
      let output: ClassificationOutput;
      let source: classification_source;
      let providerName = provider.name;
      let model = provider.model;
      if (strongest && strongest.confidence >= env.AI_CLASSIFICATION_RULE_THRESHOLD) {
        output = { ...strongest, requiresReview: false };
        source = 'RULE';
        providerName = 'rules';
        model = null;
        counts.rule += 1;
      } else if (!provider.enabled) {
        if (!strongest) {
          counts.failed += 1;
          return;
        }
        output = {
          ...strongest,
          recommendedAction: 'REVIEW_REQUIRED',
          requiresReview: true,
        };
        source = 'RULE';
        providerName = 'rules';
        model = null;
        counts.rule += 1;
      } else {
        const providerResult = await this.callProviderWithRetry(provider, input, rules);
        output = validateClassificationOutput(providerResult.output);
        source = strongest ? 'HYBRID' : 'AI';
        counts.ai += 1;
        counts.providerCalls += 1;
        counts.inputUnits = (counts.inputUnits ?? 0) + (providerResult.inputUnits ?? 0);
        counts.outputUnits = (counts.outputUnits ?? 0) + (providerResult.outputUnits ?? 0);
      }
      if (
        output.confidence < env.AI_CLASSIFICATION_REVIEW_THRESHOLD ||
        output.confidence < env.AI_CLASSIFICATION_MIN_CONFIDENCE
      ) {
        output = { ...output, recommendedAction: 'REVIEW_REQUIRED', requiresReview: true };
      }
      await classificationRepository.storeResult({
        accountId,
        messageId: message.id,
        category: output.category,
        recommendedAction: output.recommendedAction,
        confidence: output.confidence,
        requiresReview: output.requiresReview,
        explanation: output.explanation,
        reasonCodes: output.reasonCodes,
        source,
        classifierVersion: CLASSIFIER_VERSION,
        promptVersion: PROMPT_VERSION,
        taxonomyVersion: TAXONOMY_VERSION,
        provider: providerName,
        model,
        inputHash: metadataHash,
        metadataHash,
        status: output.requiresReview ? 'NEEDS_REVIEW' : 'COMPLETED',
      });
      counts.processed += 1;
      if (output.requiresReview) counts.review += 1;
    } catch (error) {
      counts.failed += 1;
      if (error instanceof ClassificationError && !error.retryable) return;
      throw error;
    }
  }

  private async callProviderWithRetry(
    provider: EmailClassifierProvider,
    input: Parameters<EmailClassifierProvider['classify']>[0],
    ruleSignals: RuleSignal[],
  ) {
    let attempt = 0;
    for (;;) {
      try {
        return await provider.classify(input, {
          ruleSignals,
          prompt: buildClassificationPrompt(),
        });
      } catch (error) {
        if (
          !(error instanceof ClassificationError) ||
          !error.retryable ||
          attempt >= env.AI_CLASSIFIER_MAX_RETRIES
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempt, 2000)));
        attempt += 1;
      }
    }
  }

  async status(userId: string) {
    const account = await classificationRepository.activeAccountForUser(userId);
    const provider = this.providerFactory();
    const data = await classificationRepository.status(account.id);
    return {
      enabled: provider.enabled,
      provider: provider.name,
      model: provider.model,
      running: Boolean(data.state?.lease_expires_at && data.state.lease_expires_at > new Date()),
      activeRunId: data.state?.active_run_id ?? null,
      classifiedCount: data.classifiedCount,
      reviewRequiredCount: data.reviewCount,
      lastClassifiedAt: data.latestRun?.completed_at?.toISOString() ?? null,
      lastErrorCode: data.latestRun?.last_error_code ?? data.state?.last_error_code ?? null,
      latestRun: data.latestRun
        ? {
            id: data.latestRun.id,
            status: data.latestRun.status,
            requestedMessageCount: data.latestRun.requested_message_count,
            processedMessageCount: data.latestRun.processed_message_count,
            reusedResultCount: data.latestRun.reused_result_count,
            ruleClassifiedCount: data.latestRun.rule_classified_count,
            aiClassifiedCount: data.latestRun.ai_classified_count,
            reviewRequiredCount: data.latestRun.review_required_count,
            failedCount: data.latestRun.failed_count,
          }
        : null,
      categoryDistribution: Object.fromEntries(
        data.categoryGroups.map((group) => [group.category, group._count]),
      ),
      recommendationDistribution: Object.fromEntries(
        data.actionGroups.map((group) => [group.recommended_action, group._count]),
      ),
      versions: {
        classifier: CLASSIFIER_VERSION,
        prompt: PROMPT_VERSION,
        taxonomy: TAXONOMY_VERSION,
      },
    };
  }

  async results(
    userId: string,
    options: {
      category?: ClassificationCategory | undefined;
      recommendedAction?: RecommendedAction | undefined;
      requiresReview?: boolean | undefined;
      status?: 'PENDING' | 'COMPLETED' | 'FAILED' | 'NEEDS_REVIEW' | 'SUPERSEDED' | undefined;
      cursor?: string | undefined;
      limit: number;
    },
  ) {
    const account = await classificationRepository.activeAccountForUser(userId);
    const records = await classificationRepository.listResults(account.id, options);
    const hasNextPage = records.length > options.limit;
    const page = hasNextPage ? records.slice(0, options.limit) : records;
    return {
      results: page.map((record) => this.resultDto(record)),
      nextCursor: hasNextPage ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async result(userId: string, id: string) {
    const account = await classificationRepository.activeAccountForUser(userId);
    const result = await classificationRepository.resultForUser(id, account.id);
    if (!result) {
      throw new AppError(
        'CLASSIFICATION_RESULT_NOT_FOUND',
        'Classification recommendation not found.',
        404,
      );
    }
    return this.resultDto(result);
  }

  async correct(
    userId: string,
    id: string,
    correctedCategory: ClassificationCategory,
    correctedAction: RecommendedAction,
    feedbackReason?: string,
  ) {
    const account = await classificationRepository.activeAccountForUser(userId);
    const correction = await classificationRepository.correct(
      id,
      account.id,
      userId,
      correctedCategory,
      correctedAction,
      feedbackReason,
    );
    await auditService.record({
      userId,
      action: 'classification.recommendation.corrected',
      result: 'SUCCESS',
      metadata: { classificationResultId: id },
    });
    return {
      id: correction.id,
      classificationResultId: correction.classification_result_id,
      correctedCategory: correction.corrected_category,
      correctedRecommendedAction: correction.corrected_recommended_action,
      feedbackReason: correction.feedback_reason,
      createdAt: correction.created_at.toISOString(),
    };
  }

  private runDto(lease: ClassificationLease, counts: RunCounts, provider: EmailClassifierProvider) {
    return {
      success: true,
      runId: lease.runId,
      provider: provider.name,
      model: provider.model,
      ...counts,
    };
  }

  private resultDto(record: {
    id: string;
    gmail_message_id: string;
    category: ClassificationCategory;
    recommended_action: RecommendedAction;
    confidence: number;
    requires_review: boolean;
    explanation: string;
    reason_codes: string[];
    source: string;
    status: string;
    classifier_version: string;
    prompt_version: string;
    taxonomy_version: string;
    classified_at: Date;
    gmail_message_metadata: {
      subject: string | null;
      sender_name: string | null;
      sender_email: string | null;
      snippet: string | null;
      label_ids: string[];
      internal_date: Date | null;
    };
    corrections: Array<{
      id: string;
      corrected_category: ClassificationCategory;
      corrected_recommended_action: RecommendedAction;
      feedback_reason: string | null;
      created_at: Date;
    }>;
  }) {
    const senderDomain = record.gmail_message_metadata.sender_email?.split('@').at(-1) ?? null;
    const correction = record.corrections[0];
    return {
      id: record.id,
      messageId: record.gmail_message_id,
      message: {
        subject: record.gmail_message_metadata.subject,
        sender: record.gmail_message_metadata.sender_name || senderDomain || 'Unknown sender',
        senderDomain,
        snippet: record.gmail_message_metadata.snippet,
        gmailLabels: record.gmail_message_metadata.label_ids,
        date: record.gmail_message_metadata.internal_date?.toISOString() ?? null,
      },
      recommendedCategory: record.category,
      suggestedAction: record.recommended_action,
      confidence: record.confidence,
      requiresReview: record.requires_review,
      explanation: record.explanation,
      reasonCodes: record.reason_codes,
      source: record.source,
      status: record.status,
      versions: {
        classifier: record.classifier_version,
        prompt: record.prompt_version,
        taxonomy: record.taxonomy_version,
      },
      classifiedAt: record.classified_at.toISOString(),
      correction: correction
        ? {
            id: correction.id,
            correctedCategory: correction.corrected_category,
            correctedRecommendedAction: correction.corrected_recommended_action,
            feedbackReason: correction.feedback_reason,
            createdAt: correction.created_at.toISOString(),
          }
        : null,
    };
  }
}

export const classificationService = new ClassificationService();
