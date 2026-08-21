import { createHash, randomUUID } from 'node:crypto';
import type { automation_trigger, gmail_message_metadata, user_labels } from '@prisma/client';

import { auditService } from '@api/audit/audit.service.js';
import { env } from '@api/config/env.js';
import { logger, safeErrorDetails } from '@api/config/logger.js';
import { prisma } from '@api/database/prisma.js';
import { AppError } from '@api/errors/AppError.js';
import {
  activityService,
  type ProgressReporter,
  type RunOutcome,
  type StartedRun,
} from '@api/features/activity/activity.service.js';
import { gmailSyncService } from '@api/integrations/gmail/gmail.service.js';
import {
  RULE_PRIORITY,
  byRuleSpecificity,
  findMatchingRule,
  type RoutingRuleKind,
} from '@api/features/label-discovery/routing-rules.js';
import { automationGmailService, type AutomationGmailService } from './automation-gmail.service.js';
import {
  GeminiProviderError,
  estimatedCostMicroUsd,
  geminiAutomationProvider,
} from './gemini-automation.provider.js';
import {
  NO_LABEL,
  type AutomationClassification,
  type AutomationClassifier,
  type AutomationMessageInput,
  type AutomationUsage,
} from './automation.types.js';

type RunCounters = {
  messagesSeen: number;
  patternReused: number;
  aiClassified: number;
  reviewRequired: number;
  noLabelSkipped: number;
  backfillRemaining: number;
  labelsCreated: number;
  labelsReused: number;
  messagesLabeled: number;
  failed: number;
  providerCalls: number;
  usage: AutomationUsage;
  costMicrousd: number;
  stoppedReason: string | null;
  lastErrorCode: string | null;
  lastProviderStatus: number | null;
  lastProviderCode: string | null;
  lastProviderRequestId: string | null;
};

const emptyCounters = (): RunCounters => ({
  messagesSeen: 0,
  patternReused: 0,
  aiClassified: 0,
  reviewRequired: 0,
  noLabelSkipped: 0,
  backfillRemaining: 0,
  labelsCreated: 0,
  labelsReused: 0,
  messagesLabeled: 0,
  failed: 0,
  providerCalls: 0,
  usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
  costMicrousd: 0,
  stoppedReason: null,
  lastErrorCode: null,
  lastProviderStatus: null,
  lastProviderCode: null,
  lastProviderRequestId: null,
});

function senderDomain(message: Pick<gmail_message_metadata, 'sender_email'>): string {
  return message.sender_email?.split('@').at(-1)?.trim().toLowerCase() || 'unknown.invalid';
}

function hashMessage(message: gmail_message_metadata): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        message.subject,
        message.sender_email,
        message.snippet,
        message.internal_date?.toISOString(),
      ]),
    )
    .digest('hex');
}

/**
 * The endings that are not exceptions. A run that hits one of these did real work and then quit
 * for a reason the user needs to read, which is exactly what the old contract had nowhere to put.
 */
const STOP_REASON_MESSAGES: Record<string, string> = {
  DAILY_BUDGET_REACHED:
    'This run stopped at the daily Gemini budget. Everything filed so far is saved and the rest continues on the next run.',
  PROVIDER_RATE_LIMITED:
    'Gemini rate-limited this run. Everything filed so far is saved and the rest resumes on the next scheduled run.',
  PROVIDER_UNUSABLE:
    'Gemini returned unusable responses several times in a row, so this run stopped early. Everything filed so far is saved and the rest resumes on the next run.',
};

/** Batches that fail back to back mean the provider, not the mail, so the run gives up. */
const MAX_CONSECUTIVE_BATCH_FAILURES = 3;

/**
 * Output tokens one classification needs, used to decide whether the remaining daily budget can
 * still answer a whole batch. Measured at roughly 65 across real runs; doubled for headroom, since
 * underestimating truncates the response and overestimating only stops the run one batch early.
 */
const MIN_OUTPUT_TOKENS_PER_MESSAGE = 120;

function nextDailyRun(hourUtc: number, from = new Date()): Date {
  const next = new Date(from);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

function scheduledKey(accountId: string, now: Date, failureCount: number): string {
  return `${accountId}:scheduled:${now.toISOString().slice(0, 10)}:attempt:${failureCount}`;
}

function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : 'AUTOMATION_FAILED';
}

/**
 * The stored explanation must be 1-500 characters. A model is free to return an empty string, and
 * an empty one would fail the row's check the same way an empty label path did — losing the whole
 * batch over a cosmetic field.
 */
function explanationOf(classification: AutomationClassification): string {
  const explanation = classification.explanation.trim().slice(0, 500);
  return explanation.length > 0 ? explanation : 'No explanation returned.';
}

function safeProviderDetails(error: unknown) {
  return error instanceof GeminiProviderError
    ? {
        providerStatus: error.providerStatus,
        providerCode: error.providerCode,
        providerRequestId: error.requestId,
        retryable: error.retryable,
      }
    : {};
}

// Notional only: the free tier bills nothing. The provider derives this from Gemini's published
// paid rates so AUTOMATION_MAX_COST_MICRO_USD still bounds a runaway run.
function estimatedCost(usage: AutomationUsage): number {
  return estimatedCostMicroUsd(usage);
}

export class AutomationService {
  constructor(
    private readonly classifier: AutomationClassifier = geminiAutomationProvider,
    private readonly gmail: AutomationGmailService = automationGmailService,
  ) {}

  /**
   * Accepts a filing run and answers immediately. A run syncs the mailbox and then classifies up
   * to AUTOMATION_MAX_MESSAGES_PER_RUN messages at one Gemini request every few seconds, which is
   * far longer than a browser will wait. Preconditions the caller can act on are still checked
   * here, so a misconfigured account gets a 4xx instead of a run record it has to go read.
   */
  async start(userId: string): Promise<StartedRun> {
    const account = await this.connectedAccount(userId);
    await this.assertRunnable(account.id);
    const started = await activityService.start({
      accountId: account.id,
      kind: 'AUTOMATION_FILING',
      trigger: 'MANUAL',
    });
    if (!started.alreadyRunning) {
      activityService.runDetached(started.runId, (report) =>
        this.executeForActivity(account.id, userId, 'MANUAL', report),
      );
    }
    return started;
  }

  /** The scheduler has no HTTP caller, so the run record is the only place a failure can surface. */
  async runScheduledAccount(accountId: string, userId: string) {
    const started = await activityService.start({
      accountId,
      kind: 'AUTOMATION_FILING',
      trigger: 'SCHEDULED',
    });
    if (started.alreadyRunning) return { success: false, runId: null, status: 'RUNNING' as const };
    await activityService.runToCompletion(started.runId, (report) =>
      this.executeForActivity(accountId, userId, 'SCHEDULED', report),
    );
    return { success: true, runId: started.runId, status: 'ACCEPTED' as const };
  }

  /** Kept for callers that want to await a filing run directly, such as tests. */
  async run(userId: string) {
    const account = await this.connectedAccount(userId);
    return this.execute(account.id, userId, 'MANUAL');
  }

  /**
   * Maps a filing run onto the activity record. A run that stops for a reason — the daily budget,
   * a rate limit — is `STOPPED`, not a failure: it did what it could and the reason is readable.
   */
  private async executeForActivity(
    accountId: string,
    userId: string,
    trigger: automation_trigger,
    report: ProgressReporter,
  ): Promise<RunOutcome> {
    const result = await this.execute(accountId, userId, trigger, report);
    const counts = result.counters;
    const seen = counts['messagesSeen'] ?? 0;
    const stopped = Boolean(result.stoppedReason) || result.status !== 'COMPLETED';
    return {
      state: stopped ? 'STOPPED' : 'SUCCEEDED',
      stopReason: result.stoppedReason ?? (stopped ? result.status : null),
      errorCode: result.lastErrorCode ?? null,
      errorMessage: this.stopMessage(result.stoppedReason, result.lastErrorCode),
      processed: seen,
      total: seen,
      counts,
      featureRunId: result.runId,
    };
  }

  private stopMessage(stoppedReason: string | null, errorCode: string | null): string | null {
    if (stoppedReason) return STOP_REASON_MESSAGES[stoppedReason] ?? stoppedReason;
    if (errorCode) {
      return 'Part of this run did not finish. Nothing was lost; it resumes on the next run.';
    }
    return null;
  }

  /** The counters the activity view shows, and the progress a poll reads mid-run. */
  private progressOf(counters: RunCounters): {
    processed: number;
    total: number;
    counts: Record<string, number>;
  } {
    const processed =
      counters.patternReused +
      counters.aiClassified +
      counters.noLabelSkipped +
      counters.reviewRequired;
    return {
      processed: Math.min(processed, counters.messagesSeen),
      total: counters.messagesSeen,
      counts: {
        messagesSeen: counters.messagesSeen,
        patternReused: counters.patternReused,
        aiClassified: counters.aiClassified,
        messagesLabeled: counters.messagesLabeled,
        reviewRequired: counters.reviewRequired,
        noLabelSkipped: counters.noLabelSkipped,
        failed: counters.failed,
        backlogRemaining: counters.backfillRemaining,
        providerCalls: counters.providerCalls,
        estimatedCostMicrousd: counters.costMicrousd,
      },
    };
  }

  /** Preconditions worth a synchronous error rather than a run record nobody is watching. */
  private async assertRunnable(accountId: string): Promise<void> {
    if (!env.AUTOMATION_ENABLED) {
      throw new AppError('AUTOMATION_DISABLED', 'Daily automation is disabled.', 503);
    }
    if (!env.GEMINI_API_KEY) {
      throw new AppError('AUTOMATION_NOT_CONFIGURED', 'Gemini is not configured.', 503);
    }
    const approved = await prisma.user_labels.count({
      where: { connected_google_account_id: accountId },
    });
    if (approved === 0) {
      throw new AppError(
        'AUTOMATION_NO_APPROVED_LABELS',
        'Propose and confirm labels before automation can file mail.',
        409,
      );
    }
  }

  async status(userId: string) {
    const account = await prisma.connected_google_accounts.findFirst({
      where: { user_id: userId },
      orderBy: { updated_at: 'desc' },
    });
    if (!account) {
      return {
        gmailConnected: false,
        requiresReauthentication: false,
        enabled: false,
        running: false,
        nextRunAt: null,
        lastRun: null,
        usageToday: this.emptyUsage(),
        pendingReviewCount: 0,
        approvedLabelCount: 0,
        labelsReady: false,
        backlogRemaining: 0,
      };
    }
    const [settings, state, lastRun, usage, pendingReviewCount, approvedLabelCount, backlog] =
      await Promise.all([
        prisma.automation_settings.findUnique({
          where: { connected_google_account_id: account.id },
        }),
        prisma.automation_states.findUnique({
          where: { connected_google_account_id: account.id },
        }),
        prisma.automation_runs.findFirst({
          where: { connected_google_account_id: account.id },
          orderBy: { started_at: 'desc' },
        }),
        prisma.automation_runs.aggregate({
          where: {
            connected_google_account_id: account.id,
            started_at: { gte: new Date(new Date().setUTCHours(0, 0, 0, 0)) },
          },
          _sum: {
            provider_call_count: true,
            input_tokens: true,
            cached_input_tokens: true,
            output_tokens: true,
            estimated_cost_microusd: true,
            messages_labeled_count: true,
          },
        }),
        prisma.automation_message_actions.count({
          where: { connected_google_account_id: account.id, status: 'REVIEW_REQUIRED' },
        }),
        prisma.user_labels.count({ where: { connected_google_account_id: account.id } }),
        this.backlogCount(account.id),
      ]);
    return {
      gmailConnected: account.gmail_connected && account.connection_status === 'CONNECTED',
      requiresReauthentication: account.connection_status === 'REAUTH_REQUIRED',
      enabled: (settings?.enabled ?? env.AUTOMATION_ENABLED) && Boolean(env.GEMINI_API_KEY),
      running: Boolean(state?.lease_expires_at && state.lease_expires_at > new Date()),
      nextRunAt: state?.next_run_at?.toISOString() ?? null,
      retryAt: state?.retry_at?.toISOString() ?? null,
      lastErrorCode: state?.last_error_code ?? null,
      lastRun: lastRun ? this.serializeRun(lastRun) : null,
      usageToday: {
        providerCalls: usage._sum.provider_call_count ?? 0,
        inputTokens: usage._sum.input_tokens ?? 0,
        cachedInputTokens: usage._sum.cached_input_tokens ?? 0,
        outputTokens: usage._sum.output_tokens ?? 0,
        estimatedCostMicrousd: usage._sum.estimated_cost_microusd ?? 0,
        messagesLabeled: usage._sum.messages_labeled_count ?? 0,
      },
      limits: {
        inputTokens: env.AUTOMATION_MAX_INPUT_TOKENS,
        outputTokens: env.AUTOMATION_MAX_OUTPUT_TOKENS,
        estimatedCostMicrousd: env.AUTOMATION_MAX_COST_MICRO_USD,
        messages: env.AUTOMATION_MAX_MESSAGES_PER_RUN,
      },
      pendingReviewCount,
      approvedLabelCount,
      labelsReady: approvedLabelCount > 0,
      backlogRemaining: backlog,
    };
  }

  async reviewQueue(userId: string) {
    const actions = await prisma.automation_message_actions.findMany({
      where: { user_id: userId, status: 'REVIEW_REQUIRED' },
      include: {
        message: {
          select: {
            subject: true,
            sender_name: true,
            sender_email: true,
            snippet: true,
            internal_date: true,
          },
        },
      },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
    return {
      items: actions.map((action) => ({
        id: action.id,
        labelName: action.label_name,
        labelPath: action.label_path,
        confidence: action.confidence,
        explanation: action.explanation,
        reasonCodes: action.reason_codes,
        createdAt: action.created_at.toISOString(),
        message: {
          subject: action.message.subject ?? '(no subject)',
          senderName: action.message.sender_name,
          senderEmail: action.message.sender_email,
          snippet: action.message.snippet,
          receivedAt: action.message.internal_date?.toISOString() ?? null,
        },
      })),
    };
  }

  async approve(userId: string, actionId: string, labelName: string) {
    const action = await this.reviewableAction(userId, actionId);
    const approved = await this.approvedLabel(action.connected_google_account_id, labelName);
    const labelPath = approved.full_path;
    const label = await this.gmail.ensureLabel(action.connected_google_account_id, labelPath);
    await this.gmail.applyLabel(
      action.connected_google_account_id,
      action.message.gmail_message_id,
      label.id,
    );
    await prisma.automation_message_actions.update({
      where: { id: action.id },
      data: {
        status: 'APPLIED',
        label_name: approved.leaf_name,
        label_path: labelPath,
        gmail_label_id: label.id,
        confidence: 1,
        source: 'USER',
        reviewed_at: new Date(),
        applied_at: new Date(),
        attempt_count: { increment: 1 },
        last_error_code: null,
      },
    });
    await prisma.gmail_message_metadata.update({
      where: { id: action.gmail_message_id },
      data: { label_ids: [...new Set([...action.message.label_ids, label.id])] },
    });
    if (!approved.gmail_label_id) {
      await prisma.user_labels.update({
        where: { id: approved.id },
        data: { gmail_label_id: label.id },
      });
    }
    await this.learn(
      action.connected_google_account_id,
      senderDomain(action.message),
      { ...approved, gmail_label_id: label.id },
      1,
    );
    await auditService.record({
      action: 'automation.review.approved',
      result: 'SUCCESS',
      userId,
      metadata: { actionId, labelName: approved.leaf_name },
    });
    return { success: true };
  }

  async skip(userId: string, actionId: string) {
    const action = await this.reviewableAction(userId, actionId);
    await prisma.automation_message_actions.update({
      where: { id: action.id },
      data: { status: 'SKIPPED', reviewed_at: new Date(), source: 'USER' },
    });
    await auditService.record({
      action: 'automation.review.skipped',
      result: 'SUCCESS',
      userId,
      metadata: { actionId },
    });
    return { success: true };
  }

  async eligibleScheduledAccounts() {
    const now = new Date();
    return prisma.connected_google_accounts.findMany({
      where: {
        gmail_connected: true,
        connection_status: 'CONNECTED',
        AND: [
          {
            OR: [{ automation_settings: null }, { automation_settings: { is: { enabled: true } } }],
          },
          {
            OR: [
              { automation_state: null },
              { automation_state: { is: { next_run_at: { lte: now } } } },
              { automation_state: { is: { retry_at: { lte: now } } } },
            ],
          },
        ],
      },
      select: { id: true, user_id: true },
      take: 20,
    });
  }

  private async execute(
    accountId: string,
    userId: string,
    trigger: automation_trigger,
    report?: ProgressReporter,
  ) {
    if (!env.AUTOMATION_ENABLED) {
      throw new AppError('AUTOMATION_DISABLED', 'Daily automation is disabled.', 503);
    }
    if (!env.GEMINI_API_KEY) {
      throw new AppError('AUTOMATION_NOT_CONFIGURED', 'Gemini is not configured.', 503);
    }
    const storedLabels = await prisma.user_labels.findMany({
      where: { connected_google_account_id: accountId },
      orderBy: { created_at: 'asc' },
    });
    // Filing targets leaves only. A parent is a container in the tree and deliberately has no
    // Gmail label, but the apply path creates whatever path it is handed — so offering a parent
    // to the classifier, or letting a rule point at one, would create a folder in Gmail that the
    // design says never exists there. Rules aimed at a parent simply stop resolving, and their
    // mail goes to the model instead.
    const approvedLabels = storedLabels.filter(
      (label) => !storedLabels.some((other) => other.parent_id === label.id),
    );
    if (approvedLabels.length === 0) {
      throw new AppError(
        'AUTOMATION_NO_APPROVED_LABELS',
        'Propose and confirm labels before automation can file mail.',
        409,
      );
    }
    const now = new Date();
    const token = randomUUID();
    const [, initialState] = await Promise.all([
      prisma.automation_settings.upsert({
        where: { connected_google_account_id: accountId },
        create: {
          connected_google_account_id: accountId,
          schedule_hour_utc: env.AUTOMATION_SCHEDULE_HOUR_UTC,
          confidence_threshold: env.AUTOMATION_CONFIDENCE_THRESHOLD,
        },
        update: {},
      }),
      prisma.automation_states.upsert({
        where: { connected_google_account_id: accountId },
        create: {
          connected_google_account_id: accountId,
          next_run_at: nextDailyRun(env.AUTOMATION_SCHEDULE_HOUR_UTC),
        },
        update: {},
      }),
    ]);
    const idempotencyKey =
      trigger === 'SCHEDULED'
        ? scheduledKey(accountId, now, initialState.failure_count)
        : `${accountId}:manual:${randomUUID()}`;
    const acquired = await prisma.automation_states.updateMany({
      where: {
        connected_google_account_id: accountId,
        OR: [{ lease_expires_at: null }, { lease_expires_at: { lt: now } }],
      },
      data: {
        lease_token: token,
        lease_expires_at: new Date(now.getTime() + env.AUTOMATION_LEASE_SECONDS * 1000),
        last_run_started_at: now,
        last_error_code: null,
        retry_at: null,
      },
    });
    if (acquired.count !== 1) {
      throw new AppError('AUTOMATION_ALREADY_RUNNING', 'Mail automation is already running.', 409);
    }

    await prisma.automation_runs.updateMany({
      where: { connected_google_account_id: accountId, status: 'RUNNING' },
      data: {
        status: 'PARTIAL',
        completed_at: now,
        last_error_code: 'STALE_AUTOMATION_LEASE_RECOVERED',
      },
    });
    let run;
    try {
      run = await prisma.automation_runs.create({
        data: {
          connected_google_account_id: accountId,
          idempotency_key: idempotencyKey,
          trigger,
        },
      });
    } catch (error) {
      await this.releaseLease(accountId, token, false, null);
      if (trigger === 'SCHEDULED') {
        const existing = await prisma.automation_runs.findUnique({
          where: { idempotency_key: idempotencyKey },
        });
        if (existing) {
          // This scheduled slot already ran today; report that run rather than starting a second.
          return {
            success: existing.status === 'COMPLETED',
            runId: existing.id,
            status: existing.status,
            stoppedReason: existing.stopped_reason,
            lastErrorCode: existing.last_error_code,
            counters: {} as Record<string, number>,
          };
        }
      }
      throw error;
    }
    const runAttached = await prisma.automation_states.updateMany({
      where: { connected_google_account_id: accountId, lease_token: token },
      data: { active_run_id: run.id },
    });
    if (runAttached.count !== 1) {
      throw new AppError('AUTOMATION_ALREADY_RUNNING', 'The automation lease was replaced.', 409);
    }
    const counters = emptyCounters();
    await auditService.record({
      action: 'automation.run.started',
      result: 'INFO',
      userId,
      metadata: { runId: run.id, trigger },
    });

    try {
      await this.renewLease(accountId, token);
      await this.refreshMailbox(userId);
      await this.renewLease(accountId, token);
      await this.retryFailedActions(accountId, token, counters);
      await this.renewLease(accountId, token);
      const dailyUsage = await prisma.automation_runs.aggregate({
        where: {
          connected_google_account_id: accountId,
          id: { not: run.id },
          started_at: { gte: new Date(new Date().setUTCHours(0, 0, 0, 0)) },
        },
        _sum: {
          input_tokens: true,
          output_tokens: true,
          estimated_cost_microusd: true,
        },
      });
      const inputTokensUsed = dailyUsage._sum.input_tokens ?? 0;
      const outputTokensUsed = dailyUsage._sum.output_tokens ?? 0;
      const costUsed = dailyUsage._sum.estimated_cost_microusd ?? 0;
      const messages = await this.unprocessedMessages(accountId);
      counters.messagesSeen = messages.length;
      counters.backfillRemaining = Math.max(
        0,
        (await this.backlogCount(accountId)) - messages.length,
      );

      // Rules before AI. Every message a routing rule covers is filed here, with no model call
      // and no token budget spent; only what is left over reaches Gemini.
      const rules = await this.routingRules(accountId, approvedLabels);
      const undecided: gmail_message_metadata[] = [];
      for (const [index, message] of messages.entries()) {
        if (index % env.AUTOMATION_BATCH_SIZE === 0) await this.renewLease(accountId, token);
        const rule = findMatchingRule(rules, {
          subject: message.subject,
          senderEmail: message.sender_email,
        });
        if (!rule) {
          undecided.push(message);
          continue;
        }
        counters.patternReused += 1;
        await this.persistAndApply(
          run.id,
          userId,
          accountId,
          message,
          {
            key: message.id,
            labelName: rule.label.leaf_name,
            confidence: rule.confidence,
            explanation: `Routing rule ${rule.kind} "${rule.value}".`,
            reasonCodes: ['ROUTING_RULE', rule.kind],
          },
          approvedLabels,
          counters,
          'LEARNED_PATTERN',
        );
      }
      if (rules.length > 0) {
        await prisma.learned_classification_patterns.updateMany({
          where: { id: { in: rules.map((rule) => rule.id) } },
          data: { last_used_at: new Date() },
        });
      }
      await report?.(this.progressOf(counters));

      let consecutiveBatchFailures = 0;
      for (let index = 0; index < undecided.length; index += env.AUTOMATION_BATCH_SIZE) {
        const batch = undecided.slice(index, index + env.AUTOMATION_BATCH_SIZE);
        const roughTokens = Math.ceil(
          batch.reduce(
            (total, message) =>
              total +
              (message.subject?.length ?? 0) +
              (message.sender_email?.length ?? 0) +
              (message.snippet?.length ?? 0),
            0,
          ) / 4,
        );
        const remainingOutputTokens =
          env.AUTOMATION_MAX_OUTPUT_TOKENS - outputTokensUsed - counters.usage.outputTokens;
        const outputTokenReserve = Math.min(2000, remainingOutputTokens);
        const projectedCost = estimatedCost({
          inputTokens: roughTokens,
          cachedInputTokens: 0,
          outputTokens: Math.max(0, outputTokenReserve),
        });
        // The reserve becomes this batch's maxOutputTokens, so it has to be large enough to hold
        // one result per message. Sending a batch that cannot be answered in full returns a
        // truncated body, which surfaces as a provider fault rather than the budget stop it
        // actually is — the run then looks broken instead of finished for the day.
        const requiredOutputTokens = batch.length * MIN_OUTPUT_TOKENS_PER_MESSAGE;
        if (
          inputTokensUsed + counters.usage.inputTokens + roughTokens >
            env.AUTOMATION_MAX_INPUT_TOKENS ||
          remainingOutputTokens < requiredOutputTokens ||
          costUsed + counters.costMicrousd + projectedCost > env.AUTOMATION_MAX_COST_MICRO_USD
        ) {
          counters.stoppedReason = 'DAILY_BUDGET_REACHED';
          break;
        }
        try {
          await this.renewLease(accountId, token);
          const providerInputs = batch.map((message, batchIndex) => ({
            ...this.providerInput(message),
            key: `m${batchIndex + 1}`,
          }));
          counters.providerCalls += 1;
          const result = await this.classifier.classify(providerInputs, {
            labelNames: approvedLabels.map((label) => label.leaf_name),
            maxOutputTokens: outputTokenReserve,
          });
          counters.aiClassified += result.classifications.length;
          counters.usage.inputTokens += result.usage.inputTokens;
          counters.usage.cachedInputTokens += result.usage.cachedInputTokens;
          counters.usage.outputTokens += result.usage.outputTokens;
          counters.costMicrousd += estimatedCost(result.usage);
          const byKey = new Map(result.classifications.map((item) => [item.key, item]));
          for (const [batchIndex, message] of batch.entries()) {
            await this.persistAndApply(
              run.id,
              userId,
              accountId,
              message,
              byKey.get(`m${batchIndex + 1}`)!,
              approvedLabels,
              counters,
            );
          }
        } catch (error) {
          counters.failed += batch.length;
          counters.lastErrorCode = errorCode(error);
          if (error instanceof GeminiProviderError) {
            counters.lastProviderStatus = error.providerStatus;
            counters.lastProviderCode = error.providerCode;
            counters.lastProviderRequestId = error.requestId;
            // Pacing already respects the per-minute cap, so a 429 that outlived its retries is
            // almost certainly the daily request cap. Stop the run and let the next scheduled
            // tick resume from the checkpoints rather than spending the remaining quota here.
            if (error.code === 'PROVIDER_RATE_LIMITED') {
              counters.stoppedReason = 'PROVIDER_RATE_LIMITED';
            }
          }
          logger.error(
            {
              ...safeErrorDetails(error),
              ...safeProviderDetails(error),
              runId: run.id,
              accountId,
            },
            'automation classification batch failed',
          );
          if (counters.stoppedReason) break;
          // One malformed response is not a reason to abandon the rest of the mailbox. A single
          // bad batch used to end the run and discard every message still inside the budget, so
          // the batch is left for the next run and this one carries on. A fault that is not
          // batch-specific shows up as consecutive failures, and that does stop the run.
          consecutiveBatchFailures += 1;
          if (consecutiveBatchFailures >= MAX_CONSECUTIVE_BATCH_FAILURES) {
            counters.stoppedReason = 'PROVIDER_UNUSABLE';
            break;
          }
          continue;
        }
        consecutiveBatchFailures = 0;
        await report?.(this.progressOf(counters));
      }

      const status = counters.failed > 0 || counters.stoppedReason ? 'PARTIAL' : 'COMPLETED';
      await this.finishRun(run.id, accountId, token, status, counters);
      await auditService.record({
        action: 'automation.run.completed',
        result: status === 'COMPLETED' ? 'SUCCESS' : 'FAILURE',
        userId,
        metadata: {
          runId: run.id,
          status,
          messagesSeen: counters.messagesSeen,
          messagesLabeled: counters.messagesLabeled,
          reviewRequired: counters.reviewRequired,
          failed: counters.failed,
          estimatedCostMicrousd: counters.costMicrousd,
        },
      });
      return {
        success: status === 'COMPLETED',
        runId: run.id,
        status,
        stoppedReason: counters.stoppedReason,
        lastErrorCode: counters.lastErrorCode,
        counters: this.progressOf(counters).counts,
      };
    } catch (error) {
      counters.lastErrorCode = errorCode(error);
      counters.failed += 1;
      await this.finishRun(run.id, accountId, token, 'FAILED', counters);
      logger.error(
        { ...safeErrorDetails(error), runId: run.id, accountId },
        'automation run failed',
      );
      await auditService.record({
        action: 'automation.run.failed',
        result: 'FAILURE',
        userId,
        metadata: { runId: run.id, errorCode: counters.lastErrorCode },
      });
      throw error instanceof AppError
        ? error
        : new AppError('AUTOMATION_FAILED', 'Mail automation failed safely.', 500);
    }
  }

  private providerInput(message: gmail_message_metadata): AutomationMessageInput {
    return {
      key: message.id,
      subject: (message.subject ?? '').slice(0, 500),
      sender: (message.sender_email ?? '').slice(0, 320),
      senderDomain: senderDomain(message),
      snippet: (message.snippet ?? '').slice(0, 1000),
      isUnread: message.is_unread,
      isImportant: message.is_important,
      hasAttachments: message.has_attachments,
    };
  }

  /**
   * The account's active routing rules, most specific first, restricted to labels the user has
   * actually approved. Planner rules are authoritative; rules learned from applied mail still have
   * to clear the confidence and sample thresholds before they can skip the model.
   */
  private async routingRules(accountId: string, approvedLabels: user_labels[]) {
    const stored = await prisma.learned_classification_patterns.findMany({
      where: {
        connected_google_account_id: accountId,
        active: true,
        OR: [
          { rule_source: 'PLANNER' },
          {
            confidence: { gte: env.AUTOMATION_PATTERN_MIN_CONFIDENCE },
            sample_count: { gte: env.AUTOMATION_PATTERN_MIN_SAMPLES },
          },
        ],
      },
    });
    const byId = new Map(approvedLabels.map((label) => [label.id, label]));
    const byName = new Map(approvedLabels.map((label) => [label.leaf_name, label]));
    return stored
      .flatMap((rule) => {
        const label =
          (rule.user_label_id ? byId.get(rule.user_label_id) : null) ?? byName.get(rule.label_name);
        if (!label) return [];
        return [
          {
            id: rule.id,
            kind: rule.rule_kind as RoutingRuleKind,
            value: rule.match_value,
            confidence: rule.confidence,
            label,
          },
        ];
      })
      .sort(byRuleSpecificity);
  }

  /**
   * Oldest-first so an existing backlog drains before new mail. A backfill larger than one
   * run's budget simply continues on the next run; every message is checkpointed by its
   * automation action row.
   */
  private async unprocessedMessages(accountId: string) {
    return prisma.gmail_message_metadata.findMany({
      where: this.unprocessedWhere(accountId),
      orderBy: { internal_date: 'asc' },
      take: env.AUTOMATION_MAX_MESSAGES_PER_RUN,
    });
  }

  private unprocessedWhere(accountId: string) {
    return {
      connected_google_account_id: accountId,
      deleted_at: null,
      is_draft: false,
      is_sent: false,
      is_trashed: false,
      automationAction: null,
    } as const;
  }

  private backlogCount(accountId: string): Promise<number> {
    return prisma.gmail_message_metadata.count({ where: this.unprocessedWhere(accountId) });
  }

  private async approvedLabel(accountId: string, labelName: string): Promise<user_labels> {
    const label = await prisma.user_labels.findFirst({
      where: { connected_google_account_id: accountId, leaf_name: labelName },
    });
    if (!label) {
      throw new AppError(
        'AUTOMATION_LABEL_NOT_APPROVED',
        'That label is not part of the approved set for this account.',
        400,
      );
    }
    return label;
  }

  private async persistAndApply(
    runId: string,
    userId: string,
    accountId: string,
    message: gmail_message_metadata,
    classification: AutomationClassification,
    approvedLabels: user_labels[],
    counters: RunCounters,
    source: 'AI' | 'LEARNED_PATTERN' = 'AI',
  ): Promise<void> {
    const inputHash = hashMessage(message);
    const matched = approvedLabels.find((label) => label.leaf_name === classification.labelName);

    // No approved label fits: record the decision and leave the message in the inbox.
    if (classification.labelName === NO_LABEL || !matched) {
      await prisma.automation_message_actions.create({
        data: {
          automation_run_id: runId,
          connected_google_account_id: accountId,
          gmail_message_id: message.id,
          user_id: userId,
          status: 'SKIPPED',
          label_name: NO_LABEL,
          // No folder was chosen, so there is no path to record.
          label_path: null,
          confidence: classification.confidence,
          source,
          explanation: explanationOf(classification),
          reason_codes: classification.reasonCodes.slice(0, 16),
          input_hash: inputHash,
        },
      });
      counters.noLabelSkipped += 1;
      return;
    }

    const needsReview = classification.confidence < env.AUTOMATION_CONFIDENCE_THRESHOLD;
    const action = await prisma.automation_message_actions.create({
      data: {
        automation_run_id: runId,
        connected_google_account_id: accountId,
        gmail_message_id: message.id,
        user_id: userId,
        status: needsReview ? 'REVIEW_REQUIRED' : 'PENDING',
        label_name: matched.leaf_name,
        label_path: matched.full_path,
        confidence: classification.confidence,
        source,
        explanation: explanationOf(classification),
        reason_codes: classification.reasonCodes.slice(0, 16),
        input_hash: inputHash,
      },
    });
    if (needsReview) {
      counters.reviewRequired += 1;
      return;
    }
    const applied = await this.applyAction(
      action.id,
      accountId,
      message.gmail_message_id,
      matched.full_path,
      counters,
    );
    // A message filed by a rule already has one; only the model's own decisions teach new rules.
    if (applied && source === 'AI') {
      await this.learn(accountId, senderDomain(message), matched, classification.confidence);
    }
  }

  private async applyAction(
    actionId: string,
    accountId: string,
    remoteMessageId: string,
    labelPath: string,
    counters: RunCounters,
  ): Promise<boolean> {
    try {
      const label = await this.gmail.ensureLabel(accountId, labelPath);
      label.created ? (counters.labelsCreated += 1) : (counters.labelsReused += 1);
      await this.gmail.applyLabel(accountId, remoteMessageId, label.id);
      await prisma.automation_message_actions.update({
        where: { id: actionId },
        data: {
          status: 'APPLIED',
          gmail_label_id: label.id,
          applied_at: new Date(),
          attempt_count: { increment: 1 },
          next_retry_at: null,
          last_error_code: null,
        },
      });
      const stored = await prisma.automation_message_actions.findUniqueOrThrow({
        where: { id: actionId },
        include: { message: { select: { label_ids: true } } },
      });
      await prisma.gmail_message_metadata.update({
        where: { id: stored.gmail_message_id },
        data: { label_ids: [...new Set([...stored.message.label_ids, label.id])] },
      });
      counters.messagesLabeled += 1;
      return true;
    } catch (error) {
      const code = errorCode(error);
      await prisma.automation_message_actions.update({
        where: { id: actionId },
        data: {
          status: 'FAILED',
          attempt_count: { increment: 1 },
          last_error_code: code,
          next_retry_at: new Date(Date.now() + 60_000),
        },
      });
      counters.failed += 1;
      logger.warn(
        { ...safeErrorDetails(error), actionId, accountId },
        'automation Gmail label application failed',
      );
      return false;
    }
  }

  private async retryFailedActions(
    accountId: string,
    token: string,
    counters: RunCounters,
  ): Promise<void> {
    const actions = await prisma.automation_message_actions.findMany({
      where: {
        connected_google_account_id: accountId,
        status: { in: ['FAILED', 'PENDING'] },
        // A NONE decision has no path and nothing to apply, so it is never retried.
        label_path: { not: null },
        attempt_count: { lt: env.AUTOMATION_MAX_ACTION_RETRIES },
        OR: [{ next_retry_at: null }, { next_retry_at: { lte: new Date() } }],
      },
      include: { message: true },
      take: env.AUTOMATION_BATCH_SIZE,
    });
    for (const action of actions) {
      if (!action.label_path) continue;
      await this.renewLease(accountId, token);
      await this.applyAction(
        action.id,
        accountId,
        action.message.gmail_message_id,
        action.label_path,
        counters,
      );
    }
  }

  /**
   * Learns a sender-domain rule from a decision that stuck. A domain that turns out to feed two
   * different folders is deactivated rather than flip-flopping: the planner owns the cross-sender
   * routing, and a learned rule only earns its keep while it stays unambiguous.
   */
  private async learn(
    accountId: string,
    domain: string,
    label: user_labels,
    confidence: number,
  ): Promise<void> {
    const key = {
      connected_google_account_id: accountId,
      rule_kind: 'SENDER_DOMAIN' as const,
      match_value: domain,
    };
    const existing = await prisma.learned_classification_patterns.findUnique({
      where: { connected_google_account_id_rule_kind_match_value: key },
    });
    if (existing && existing.label_name !== label.leaf_name) {
      // A planner rule is the user's decision; never let observed mail overwrite or disable it.
      if (existing.rule_source === 'PLANNER') return;
      await prisma.learned_classification_patterns.update({
        where: { id: existing.id },
        data: { active: false },
      });
      return;
    }
    await prisma.learned_classification_patterns.upsert({
      where: { connected_google_account_id_rule_kind_match_value: key },
      create: {
        ...key,
        rule_source: 'LEARNED',
        user_label_id: label.id,
        priority: RULE_PRIORITY.SENDER_DOMAIN,
        label_name: label.leaf_name,
        label_path: label.full_path,
        confidence,
        successful_apply_count: 1,
      },
      update: {
        sample_count: { increment: 1 },
        successful_apply_count: { increment: 1 },
        confidence: Math.max(existing?.confidence ?? 0, confidence),
        user_label_id: label.id,
        label_path: label.full_path,
        last_used_at: new Date(),
      },
    });
  }

  private async refreshMailbox(userId: string): Promise<void> {
    try {
      await gmailSyncService.incrementalSync(userId);
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.code === 'GMAIL_INITIAL_SYNC_REQUIRED' || error.code === 'GMAIL_HISTORY_EXPIRED')
      ) {
        await gmailSyncService.initialSync(userId);
        return;
      }
      throw error;
    }
  }

  private async finishRun(
    runId: string,
    accountId: string,
    token: string,
    status: 'COMPLETED' | 'PARTIAL' | 'FAILED',
    counters: RunCounters,
  ): Promise<void> {
    await prisma.$transaction(async (transaction) => {
      const released = await transaction.automation_states.updateMany({
        where: {
          connected_google_account_id: accountId,
          lease_token: token,
          lease_expires_at: { gt: new Date() },
        },
        data: {
          lease_token: null,
          lease_expires_at: null,
          active_run_id: null,
          last_run_completed_at: new Date(),
          ...(status === 'COMPLETED'
            ? { last_successful_run_at: new Date(), failure_count: 0 }
            : { failure_count: { increment: 1 } }),
          last_error_code: counters.lastErrorCode,
          // A rate limit that survived pacing and retries means the daily request cap, which only
          // resets at midnight Pacific. Back off for an hour instead of re-failing every tick.
          retry_at:
            status !== 'COMPLETED' && counters.lastErrorCode
              ? new Date(
                  Date.now() +
                    (counters.lastErrorCode === 'PROVIDER_RATE_LIMITED'
                      ? 60 * 60_000
                      : 15 * 60_000),
                )
              : null,
          next_run_at: nextDailyRun(env.AUTOMATION_SCHEDULE_HOUR_UTC),
        },
      });
      if (released.count !== 1) {
        throw new AppError('AUTOMATION_ALREADY_RUNNING', 'The automation lease expired.', 409);
      }
      await transaction.automation_runs.update({
        where: { id: runId },
        data: {
          status,
          completed_at: new Date(),
          messages_seen: counters.messagesSeen,
          pattern_reused_count: counters.patternReused,
          ai_classified_count: counters.aiClassified,
          review_required_count: counters.reviewRequired,
          no_label_skipped_count: counters.noLabelSkipped,
          backlog_remaining: counters.backfillRemaining,
          labels_created_count: counters.labelsCreated,
          labels_reused_count: counters.labelsReused,
          messages_labeled_count: counters.messagesLabeled,
          failed_count: counters.failed,
          provider_call_count: counters.providerCalls,
          input_tokens: counters.usage.inputTokens,
          cached_input_tokens: counters.usage.cachedInputTokens,
          output_tokens: counters.usage.outputTokens,
          estimated_cost_microusd: counters.costMicrousd,
          stopped_reason: counters.stoppedReason,
          last_error_code: counters.lastErrorCode,
          last_provider_status: counters.lastProviderStatus,
          last_provider_code: counters.lastProviderCode,
          last_provider_request_id: counters.lastProviderRequestId,
        },
      });
    });
  }

  private async renewLease(accountId: string, token: string): Promise<void> {
    const renewed = await prisma.automation_states.updateMany({
      where: {
        connected_google_account_id: accountId,
        lease_token: token,
        lease_expires_at: { gt: new Date() },
      },
      data: {
        lease_expires_at: new Date(Date.now() + env.AUTOMATION_LEASE_SECONDS * 1000),
      },
    });
    if (renewed.count !== 1) {
      throw new AppError('AUTOMATION_ALREADY_RUNNING', 'The automation lease expired.', 409);
    }
  }

  private async releaseLease(
    accountId: string,
    token: string,
    successful: boolean,
    code: string | null,
  ) {
    await prisma.automation_states.updateMany({
      where: { connected_google_account_id: accountId, lease_token: token },
      data: {
        lease_token: null,
        lease_expires_at: null,
        active_run_id: null,
        ...(successful ? { last_successful_run_at: new Date() } : {}),
        last_error_code: code,
      },
    });
  }

  private async connectedAccount(userId: string) {
    const account = await prisma.connected_google_accounts.findFirst({
      where: { user_id: userId, gmail_connected: true, connection_status: 'CONNECTED' },
      orderBy: { updated_at: 'desc' },
    });
    if (!account) {
      throw new AppError('GMAIL_ACCOUNT_NOT_CONNECTED', 'Connect Gmail before automation.', 409);
    }
    return account;
  }

  private async reviewableAction(userId: string, actionId: string) {
    const action = await prisma.automation_message_actions.findFirst({
      where: { id: actionId, user_id: userId },
      include: { message: true },
    });
    if (!action) {
      throw new AppError(
        'AUTOMATION_ACTION_NOT_FOUND',
        'Automation review item was not found.',
        404,
      );
    }
    if (action.status !== 'REVIEW_REQUIRED') {
      throw new AppError(
        'AUTOMATION_ACTION_NOT_REVIEWABLE',
        'This automation item is no longer awaiting review.',
        409,
      );
    }
    return action;
  }

  private serializeRun(run: {
    id: string;
    status: string;
    trigger: string;
    messages_seen: number;
    pattern_reused_count: number;
    ai_classified_count: number;
    review_required_count: number;
    no_label_skipped_count: number;
    backlog_remaining: number;
    messages_labeled_count: number;
    failed_count: number;
    provider_call_count: number;
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    estimated_cost_microusd: number;
    stopped_reason: string | null;
    last_error_code: string | null;
    last_provider_status: number | null;
    last_provider_code: string | null;
    last_provider_request_id: string | null;
    started_at: Date;
    completed_at: Date | null;
  }) {
    return {
      id: run.id,
      status: run.status,
      trigger: run.trigger,
      messagesSeen: run.messages_seen,
      patternReused: run.pattern_reused_count,
      aiClassified: run.ai_classified_count,
      reviewRequired: run.review_required_count,
      noLabelSkipped: run.no_label_skipped_count,
      backlogRemaining: run.backlog_remaining,
      messagesLabeled: run.messages_labeled_count,
      failed: run.failed_count,
      providerCalls: run.provider_call_count,
      inputTokens: run.input_tokens,
      cachedInputTokens: run.cached_input_tokens,
      outputTokens: run.output_tokens,
      estimatedCostMicrousd: run.estimated_cost_microusd,
      stoppedReason: run.stopped_reason,
      lastErrorCode: run.last_error_code,
      lastProviderStatus: run.last_provider_status,
      lastProviderCode: run.last_provider_code,
      lastProviderRequestId: run.last_provider_request_id,
      startedAt: run.started_at.toISOString(),
      completedAt: run.completed_at?.toISOString() ?? null,
    };
  }

  private emptyUsage() {
    return {
      providerCalls: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      estimatedCostMicrousd: 0,
      messagesLabeled: 0,
    };
  }
}

export const automationService = new AutomationService();
