import type {
  dynamic_label_candidate_status,
  dynamic_label_candidates,
  label_decisions,
} from '@prisma/client';

import { auditService } from '@api/audit/audit.service.js';
import { env } from '@api/config/env.js';
import { logger } from '@api/config/logger.js';
import { AppError } from '@api/errors/AppError.js';
import { discoverDeterministicCandidates } from './label-discovery.engine.js';
import {
  buildControlledLabelPath,
  labelsAreSimilar,
  normalizeLabelForComparison,
  validateLeafName,
} from './label-normalization.js';
import {
  LABEL_CONFIDENCE_VERSION,
  LABEL_DISCOVERY_VERSION,
  LABEL_NAMING_VERSION,
  type LabelCandidateType,
} from './label-discovery.taxonomy.js';
import type {
  DiscoveryMessage,
  DiscoveryPreferenceOverrides,
  DiscoveryPreferences,
} from './label-discovery.types.js';
import { labelDiscoveryRepository, type DiscoveryRunCounts } from './label-discovery.repository.js';

const emptyCounts = (): DiscoveryRunCounts => ({
  messagesAnalyzed: 0,
  groupsDiscovered: 0,
  candidatesCreated: 0,
  candidatesReused: 0,
  candidatesRejectedByRules: 0,
  providerCalls: 0,
});

const REASON_DESCRIPTIONS: Record<string, string> = {
  SOURCE_VOLUME: 'Frequent source',
  SOURCE_RECENCY: 'Recent activity',
  DOMAIN_CONSISTENCY: 'Consistent sender domain',
  DISPLAY_NAME_CONSISTENCY: 'Consistent sender name',
  CATEGORY_AGREEMENT: 'Consistent classification',
  SUBJECT_PATTERN_AGREEMENT: 'Recurring subject theme',
  THREAD_DIVERSITY: 'Seen across multiple threads',
  EXISTING_GMAIL_CATEGORY: 'Supported by a Gmail category',
  USER_CORRECTION_SUPPORT: 'Supported by your prior corrections',
  EXISTING_LABEL_SIMILARITY: 'Similar to an existing label',
  TEMPORARY_EVENT_PENALTY: 'May be a temporary event',
  GENERIC_NAME_PENALTY: 'Name may be too generic',
};

export class LabelDiscoveryService {
  async run(userId: string, overrides: DiscoveryPreferenceOverrides) {
    if (!env.DYNAMIC_LABEL_DISCOVERY_ENABLED) {
      throw new AppError(
        'LABEL_DISCOVERY_DISABLED',
        'Dynamic label discovery is disabled by configuration.',
        409,
      );
    }
    const account = await labelDiscoveryRepository.activeAccountForUser(userId);
    const current = await labelDiscoveryRepository.status(account.id);
    if (current.pendingCount >= env.DYNAMIC_LABEL_MAX_PENDING_CANDIDATES) {
      throw new AppError(
        'LABEL_LIMIT_REACHED',
        'Review existing label suggestions before discovering more.',
        409,
      );
    }
    const preferences = this.preferences(overrides);
    const lease = await labelDiscoveryRepository.acquireLease(account.id);
    const counts = emptyCounts();
    const startedAt = Date.now();
    logger.info(
      {
        accountId: account.id,
        runId: lease.runId,
        discoveryVersion: LABEL_DISCOVERY_VERSION,
      },
      'label discovery run started',
    );
    try {
      const [records, labels] = await Promise.all([
        labelDiscoveryRepository.eligibleMessages(
          account.id,
          preferences.lookbackDays,
          env.DYNAMIC_LABEL_MAX_MESSAGES_PER_RUN,
        ),
        labelDiscoveryRepository.existingLabelNames(account.id),
      ]);
      counts.messagesAnalyzed = records.length;
      if (records.length < preferences.minMessages) {
        throw new AppError(
          'LABEL_DISCOVERY_NO_ELIGIBLE_MESSAGES',
          'Not enough eligible synchronized metadata is available.',
          422,
        );
      }
      const messages: DiscoveryMessage[] = records.map((message) => {
        const result = message.classificationResults[0];
        return {
          id: message.id,
          gmailThreadId: message.gmail_thread_id,
          internalDate: message.internal_date,
          subject: message.subject,
          senderName: message.sender_name,
          senderEmail: message.sender_email,
          gmailLabels: message.label_ids,
          category: result?.category ?? null,
          correctedCategory: result?.corrections[0]?.corrected_category ?? null,
        };
      });
      const discovery = discoverDeterministicCandidates(messages, preferences, {
        minCategoryAgreement: env.DYNAMIC_LABEL_MIN_CATEGORY_AGREEMENT,
        minSourceAgreement: env.DYNAMIC_LABEL_MIN_SOURCE_AGREEMENT,
        minimumConfidence: env.DYNAMIC_LABEL_MIN_CONFIDENCE,
        existingLabelNames: labels.map((label) => label.name),
      });
      counts.groupsDiscovered = discovery.groups.length;
      counts.candidatesRejectedByRules = discovery.rejectedByRules;
      for (const group of discovery.groups) {
        const stored = await labelDiscoveryRepository.storeCandidate(account.id, group);
        if (stored.suppressed) {
          counts.candidatesRejectedByRules += 1;
        } else if (stored.created) {
          counts.candidatesCreated += 1;
        } else {
          counts.candidatesReused += 1;
        }
      }
      await labelDiscoveryRepository.finish(lease, counts);
      await auditService.record({
        userId,
        action: 'label_discovery.run.completed',
        result: 'SUCCESS',
        metadata: {
          runId: lease.runId,
          messagesAnalyzed: counts.messagesAnalyzed,
          candidatesCreated: counts.candidatesCreated,
          candidatesReused: counts.candidatesReused,
        },
      });
      logger.info(
        {
          accountId: account.id,
          runId: lease.runId,
          ...counts,
          durationMs: Date.now() - startedAt,
          discoveryVersion: LABEL_DISCOVERY_VERSION,
        },
        'label discovery run completed',
      );
      return {
        success: true,
        runId: lease.runId,
        ...counts,
        discoveryVersion: LABEL_DISCOVERY_VERSION,
      };
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'LABEL_DISCOVERY_FAILED';
      await labelDiscoveryRepository.fail(lease, counts, code);
      logger.error(
        {
          accountId: account.id,
          runId: lease.runId,
          code,
          durationMs: Date.now() - startedAt,
          discoveryVersion: LABEL_DISCOVERY_VERSION,
        },
        'label discovery run failed',
      );
      if (error instanceof AppError) throw error;
      throw new AppError('LABEL_DISCOVERY_FAILED', 'Label discovery could not be completed.', 500);
    }
  }

  async status(userId: string) {
    const account = await labelDiscoveryRepository.activeAccountForUser(userId);
    const data = await labelDiscoveryRepository.status(account.id);
    return {
      enabled: env.DYNAMIC_LABEL_DISCOVERY_ENABLED,
      running: Boolean(data.state?.lease_expires_at && data.state.lease_expires_at > new Date()),
      activeRunId: data.state?.active_run_id ?? null,
      pendingCount: data.pendingCount,
      approvedCount: data.approvedCount,
      maxPendingCandidates: env.DYNAMIC_LABEL_MAX_PENDING_CANDIDATES,
      maxApprovedLabels: env.DYNAMIC_LABEL_MAX_APPROVED_LABELS,
      gmailLabelCreationSupported: false,
      lastErrorCode: data.latestRun?.last_error_code ?? data.state?.last_error_code ?? null,
      latestRun: data.latestRun
        ? {
            id: data.latestRun.id,
            status: data.latestRun.status,
            messagesAnalyzed: data.latestRun.messages_analyzed,
            groupsDiscovered: data.latestRun.groups_discovered,
            candidatesCreated: data.latestRun.candidates_created,
            candidatesReused: data.latestRun.candidates_reused,
            candidatesRejectedByRules: data.latestRun.candidates_rejected_by_rules,
            providerCalls: data.latestRun.provider_calls,
            completedAt: data.latestRun.completed_at?.toISOString() ?? null,
          }
        : null,
      versions: {
        discovery: LABEL_DISCOVERY_VERSION,
        naming: LABEL_NAMING_VERSION,
        confidence: LABEL_CONFIDENCE_VERSION,
      },
    };
  }

  async candidates(
    userId: string,
    options: {
      status?: dynamic_label_candidate_status | undefined;
      candidateType?: LabelCandidateType | undefined;
      cursor?: string | undefined;
      limit: number;
    },
  ) {
    const account = await labelDiscoveryRepository.activeAccountForUser(userId);
    const [records, gmailLabels] = await Promise.all([
      labelDiscoveryRepository.list(account.id, options),
      labelDiscoveryRepository.existingLabelNames(account.id),
    ]);
    const hasNextPage = records.length > options.limit;
    const page = hasNextPage ? records.slice(0, options.limit) : records;
    return {
      candidates: page.map((record) =>
        this.candidateDto(
          record,
          gmailLabels.map((label) => label.name),
          page,
        ),
      ),
      nextCursor: hasNextPage ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async candidate(userId: string, id: string) {
    const account = await labelDiscoveryRepository.activeAccountForUser(userId);
    const [candidate, gmailLabels, pool] = await Promise.all([
      labelDiscoveryRepository.candidate(account.id, id),
      labelDiscoveryRepository.existingLabelNames(account.id),
      labelDiscoveryRepository.list(account.id, { limit: 50 }),
    ]);
    if (!candidate) {
      throw new AppError('LABEL_CANDIDATE_NOT_FOUND', 'Label candidate not found.', 404);
    }
    return this.candidateDto(
      candidate,
      gmailLabels.map((label) => label.name),
      pool,
    );
  }

  async approve(userId: string, id: string, requestedLeafName?: string) {
    const account = await labelDiscoveryRepository.activeAccountForUser(userId);
    const candidate = await labelDiscoveryRepository.candidate(account.id, id);
    if (!candidate) {
      throw new AppError('LABEL_CANDIDATE_NOT_FOUND', 'Label candidate not found.', 404);
    }
    if (!['PENDING', 'DEFERRED'].includes(candidate.status)) {
      throw new AppError(
        'LABEL_CANDIDATE_NOT_ACTIVE',
        'The label candidate is no longer available for approval.',
        409,
      );
    }
    const status = await labelDiscoveryRepository.status(account.id);
    if (status.approvedCount >= env.DYNAMIC_LABEL_MAX_APPROVED_LABELS) {
      throw new AppError(
        'LABEL_LIMIT_REACHED',
        'The approved MailMind label limit has been reached.',
        409,
      );
    }
    let leafName: string;
    let fullPath: string;
    try {
      leafName = validateLeafName(requestedLeafName ?? candidate.suggested_leaf_name);
      fullPath = buildControlledLabelPath(candidate.candidate_type, leafName);
    } catch {
      throw new AppError(
        'LABEL_CANDIDATE_NAME_INVALID',
        'The requested label name is not valid.',
        400,
      );
    }
    const normalized = normalizeLabelForComparison(leafName);
    const [gmailConflict, candidateConflict] = await Promise.all([
      labelDiscoveryRepository.gmailLabelByNormalizedName(account.id, normalized),
      labelDiscoveryRepository.equivalentApproved(account.id, normalized, candidate.id),
    ]);
    if (gmailConflict || candidateConflict) {
      throw new AppError(
        'LABEL_CANDIDATE_DUPLICATE',
        'An equivalent Gmail or approved MailMind label already exists.',
        409,
      );
    }
    const renamed =
      normalizeLabelForComparison(leafName) !==
      normalizeLabelForComparison(candidate.suggested_leaf_name);
    const result = await labelDiscoveryRepository.decide({
      accountId: account.id,
      userId,
      candidateId: candidate.id,
      decision: renamed ? 'RENAME_AND_APPROVE' : 'APPROVE',
      fromStatuses: ['PENDING', 'DEFERRED'],
      toStatus: 'APPROVED',
      finalLeafName: leafName,
      finalFullPath: fullPath,
    });
    await this.auditDecision(userId, candidate.id, renamed ? 'rename_and_approve' : 'approve');
    return {
      id: result.decision.id,
      candidateId: candidate.id,
      status: 'APPROVED',
      finalLeafName: leafName,
      finalFullPath: fullPath,
      gmailLabelCreated: false,
      message: 'Suggestion approved. Gmail was not changed.',
    };
  }

  async reject(userId: string, id: string, reason?: string) {
    return this.simpleDecision(userId, id, 'REJECT', 'REJECTED', reason);
  }

  async defer(userId: string, id: string, reason?: string) {
    return this.simpleDecision(userId, id, 'DEFER', 'DEFERRED', reason);
  }

  async merge(userId: string, sourceId: string, targetId: string) {
    const account = await labelDiscoveryRepository.activeAccountForUser(userId);
    const target = await labelDiscoveryRepository.merge(account.id, userId, sourceId, targetId);
    await this.auditDecision(userId, sourceId, 'merge', { targetCandidateId: targetId });
    return {
      candidateId: sourceId,
      status: 'MERGED',
      mergedIntoCandidateId: target.id,
      mergedIntoPath: target.suggested_full_path,
      message: 'Candidates merged. Gmail was not changed.',
    };
  }

  private async simpleDecision(
    userId: string,
    id: string,
    decision: 'REJECT' | 'DEFER',
    status: 'REJECTED' | 'DEFERRED',
    reason?: string,
  ) {
    const account = await labelDiscoveryRepository.activeAccountForUser(userId);
    const result = await labelDiscoveryRepository.decide({
      accountId: account.id,
      userId,
      candidateId: id,
      decision,
      fromStatuses: decision === 'DEFER' ? ['PENDING'] : ['PENDING', 'DEFERRED'],
      toStatus: status,
      ...(reason === undefined ? {} : { decisionReason: reason }),
    });
    await this.auditDecision(userId, id, decision.toLowerCase());
    return {
      id: result.decision.id,
      candidateId: id,
      status,
      message: `${decision === 'REJECT' ? 'Suggestion rejected' : 'Suggestion deferred'}. Gmail was not changed.`,
    };
  }

  private preferences(overrides: DiscoveryPreferenceOverrides): DiscoveryPreferences {
    return {
      minMessages: overrides.minMessages ?? env.DYNAMIC_LABEL_MIN_MESSAGES,
      lookbackDays: overrides.lookbackDays ?? env.DYNAMIC_LABEL_LOOKBACK_DAYS,
      maxCandidates: Math.min(
        overrides.maxCandidates ?? env.DYNAMIC_LABEL_MAX_CANDIDATES_PER_RUN,
        env.DYNAMIC_LABEL_MAX_CANDIDATES_PER_RUN,
      ),
      allowedCandidateTypes: overrides.allowedCandidateTypes ?? [
        'SOURCE',
        'ORGANIZATION',
        'TOPIC',
        'SUBSCRIPTION',
        'PROJECT',
        'WORKFLOW',
      ],
      preferOrganizations: overrides.preferOrganizations ?? true,
      preferTopics: overrides.preferTopics ?? true,
    };
  }

  private candidateDto(
    candidate: dynamic_label_candidates & {
      decisions: label_decisions[];
      merged_into_candidate: { id: string; suggested_full_path: string } | null;
    },
    existingLabelNames: string[] = [],
    candidatePool: Array<{
      id: string;
      suggested_leaf_name: string;
      suggested_full_path: string;
      status: dynamic_label_candidate_status;
    }> = [],
  ) {
    const decision = candidate.decisions[0];
    const similarCandidate = candidatePool.find(
      (other) =>
        other.id !== candidate.id &&
        !['REJECTED', 'MERGED', 'SUPERSEDED', 'FAILED'].includes(other.status) &&
        labelsAreSimilar(other.suggested_leaf_name, candidate.suggested_leaf_name),
    );
    return {
      id: candidate.id,
      candidateType: candidate.candidate_type,
      suggestedLeafName: candidate.suggested_leaf_name,
      suggestedFullPath: candidate.suggested_full_path,
      status: candidate.status,
      confidence: candidate.confidence,
      confidenceLevel:
        candidate.confidence >= 0.9 ? 'VERY_HIGH' : candidate.confidence >= 0.8 ? 'HIGH' : 'MEDIUM',
      messageCount: candidate.message_count,
      threadCount: candidate.thread_count,
      firstMessageAt: candidate.first_message_at?.toISOString() ?? null,
      lastMessageAt: candidate.last_message_at?.toISOString() ?? null,
      dominantCategory: candidate.dominant_category,
      categoryAgreement: candidate.category_agreement,
      sourceAgreement: candidate.source_agreement,
      reasonCodes: candidate.reason_codes,
      reasons: candidate.reason_codes.map(
        (code) => REASON_DESCRIPTIONS[code] ?? 'Supporting metadata signal',
      ),
      discoveryVersion: candidate.discovery_version,
      existingLabelConflict: existingLabelNames.some((name) =>
        labelsAreSimilar(name, candidate.suggested_leaf_name),
      ),
      mergeSuggestion: candidate.merged_into_candidate
        ? {
            candidateId: candidate.merged_into_candidate.id,
            path: candidate.merged_into_candidate.suggested_full_path,
          }
        : similarCandidate
          ? {
              candidateId: similarCandidate.id,
              path: similarCandidate.suggested_full_path,
            }
          : null,
      decision: decision
        ? {
            type: decision.decision,
            finalLeafName: decision.final_leaf_name,
            finalFullPath: decision.final_full_path,
            createdAt: decision.created_at.toISOString(),
          }
        : null,
      lastDiscoveredAt: candidate.last_discovered_at.toISOString(),
    };
  }

  private async auditDecision(
    userId: string,
    candidateId: string,
    action: string,
    metadata: Record<string, unknown> = {},
  ) {
    await auditService.record({
      userId,
      action: `label_discovery.candidate.${action}`,
      result: 'SUCCESS',
      metadata: { candidateId, ...metadata },
    });
    logger.info(
      { candidateId, decision: action, discoveryVersion: LABEL_DISCOVERY_VERSION },
      'label candidate decision stored',
    );
  }
}

export const labelDiscoveryService = new LabelDiscoveryService();
