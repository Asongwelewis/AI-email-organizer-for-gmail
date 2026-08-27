import { randomUUID } from 'node:crypto';
import type { automation_trigger, user_labels } from '@prisma/client';

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
import { emailIdentity } from '@api/features/label-discovery/label-normalization.js';
import { stableSubjectPhrase } from '@api/features/label-discovery/routing-rules.js';
import { LABEL_ROOT } from '@api/features/label-discovery/taxonomy-planner.js';
import { automationGmailService, type AutomationGmailService } from './automation-gmail.service.js';
import {
  facetClassificationService,
  type FacetClassificationService,
  type FacetRunCounters,
} from './facet-classification.service.js';
import {
  facetFilingService,
  type FacetFilingService,
  type FilingCounters,
} from './facet-filing.service.js';
import {
  NO_LABEL,
  type AutomationGapCluster,
  type AutomationGapReport,
} from './automation.types.js';

/** What one run reports back to the activity record, and to a caller that awaited it. */
interface RunOutcomeSummary {
  success: boolean;
  /** The facet services own their own run rows, so there is no single id to hand back. */
  runId: string | null;
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED';
  stoppedReason: string | null;
  lastErrorCode: string | null;
  counters: Record<string, number>;
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

function nextDailyRun(hourUtc: number, from = new Date()): Date {
  const next = new Date(from);
  next.setUTCHours(hourUtc, 0, 0, 0);
  if (next <= from) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : 'AUTOMATION_FAILED';
}

/** How many recent no-fit decisions the gap report reads before clustering them. */
const GAP_REPORT_SCAN_LIMIT = 2000;

/** Below this a cluster is noise, not a folder. Matches the planner's evidence threshold. */
const GAP_REPORT_MIN_CLUSTER = 3;

/**
 * The recognisable shape of a subject line, used to group mail that arrives worded the same way.
 *
 * This has to be a phrase that is LITERALLY present in the subject, because a cluster is offered
 * as a SUBJECT_CONTAINS rule and that rule is a substring test. The previous implementation built
 * its phrase from the first three non-stopword words wherever they fell, so "Update on your
 * Zipline application" produced "update zipline application" — a rule that matched nothing at all,
 * not even the message it came from. `stableSubjectPhrase` takes a contiguous run instead, which
 * is the same phrase the facet learner stores, so a cluster the report proposes is a rule that
 * actually fires.
 */
function push(target: Map<string, string[]>, key: string, subject: string): void {
  const bucket = target.get(key) ?? [];
  bucket.push(subject);
  target.set(key, bucket);
}

function toClusters(
  grouped: Map<string, string[]>,
  kind: AutomationGapCluster['kind'],
): AutomationGapCluster[] {
  return [...grouped.entries()].map(([value, subjects]) => ({
    kind,
    value,
    messageCount: subjects.length,
    sampleSubjects: [...new Set(subjects.filter(Boolean))].slice(0, 3),
    suggestedName: suggestedLeafName(value),
  }));
}

/**
 * A mechanical starting point for a folder name: sentence case, no model involved. The person
 * approving it renames it to whatever they actually call this mail.
 */
function suggestedLeafName(value: string): string {
  const base = value.includes('@') ? value : value.replace(/\.[a-z.]+$/, '');
  const words = base
    .replace(/[^a-zA-Z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3);
  if (words.length === 0) return 'Unsorted';
  const joined = words.join(' ');
  return joined.charAt(0).toUpperCase() + joined.slice(1).toLowerCase();
}

export class AutomationService {
  constructor(
    private readonly gmail: AutomationGmailService = automationGmailService,
    private readonly classification: FacetClassificationService = facetClassificationService,
    private readonly filing: FacetFilingService = facetFilingService,
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

  /** Preconditions worth a synchronous error rather than a run record nobody is watching. */
  private async assertRunnable(accountId: string): Promise<void> {
    if (!env.AUTOMATION_ENABLED) {
      throw new AppError('AUTOMATION_DISABLED', 'Daily automation is disabled.', 503);
    }
    if (!env.GEMINI_API_KEY) {
      throw new AppError('AUTOMATION_NOT_CONFIGURED', 'Gemini is not configured.', 503);
    }
    /*
     * "There is somewhere to file into" is a precondition of filing, and only of filing. With the
     * Gmail export off a run classifies and stops, folders are computed from `message_facets` by
     * `buildPivot`, and no `user_labels` row is involved anywhere — so requiring one here would
     * refuse every run on an account that has never mirrored its folders into Gmail, which is now
     * the default account.
     */
    if (!env.GMAIL_WRITE_ENABLED) return;
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

  /**
   * What automation kept declining, grouped so it can become folders.
   *
   * A high no-fit rate is only meaningful if you can see what is in it. This clusters the messages
   * recorded as fitting nowhere by sending domain and by subject shape, and returns the groups
   * large enough to justify a folder. It creates nothing and calls no model: every cluster is a
   * suggestion that still has to go through the same human approval as any other folder.
   */
  async gapReport(userId: string, limit = 20): Promise<AutomationGapReport> {
    const account = await this.connectedAccount(userId);
    const declined = await prisma.automation_message_actions.findMany({
      where: {
        connected_google_account_id: account.id,
        label_name: NO_LABEL,
      },
      include: { message: { select: { subject: true, sender_email: true } } },
      orderBy: { created_at: 'desc' },
      take: GAP_REPORT_SCAN_LIMIT,
    });

    const byDomain = new Map<string, string[]>();
    const bySubject = new Map<string, string[]>();
    for (const action of declined) {
      const subject = action.message.subject?.trim() ?? '';
      const domain = emailIdentity(action.message.sender_email).registrableDomain;
      if (domain) push(byDomain, domain, subject);
      const shape = stableSubjectPhrase(subject);
      if (shape) push(bySubject, shape, subject);
    }

    const clusters: AutomationGapCluster[] = [
      ...toClusters(byDomain, 'SENDER_DOMAIN'),
      ...toClusters(bySubject, 'SUBJECT_CONTAINS'),
    ]
      .filter((cluster) => cluster.messageCount >= GAP_REPORT_MIN_CLUSTER)
      .sort((left, right) => right.messageCount - left.messageCount)
      .slice(0, limit);

    // A message can sit in both a domain cluster and a subject one, so the covered count is over
    // distinct messages rather than the sum of cluster sizes.
    const covered = new Set<string>();
    for (const action of declined) {
      const subject = action.message.subject?.trim() ?? '';
      const domain = emailIdentity(action.message.sender_email).registrableDomain;
      const shape = stableSubjectPhrase(subject);
      const inCluster = clusters.some((cluster) =>
        cluster.kind === 'SENDER_DOMAIN' ? cluster.value === domain : cluster.value === shape,
      );
      if (inCluster) covered.add(action.id);
    }

    return {
      analyzedCount: declined.length,
      clusteredCount: covered.size,
      clusters,
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
    // Exclusive, like every other filing path: a reviewer approving a folder for a message that
    // already wears one must move it, not add a second MailMind label to it.
    const stale = await this.currentMailMindLabelIds(
      action.connected_google_account_id,
      action.message.label_ids,
    );
    await this.gmail.applyExclusiveLabel(
      action.connected_google_account_id,
      action.message.gmail_message_id,
      label.id,
      stale,
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
      data: {
        label_ids: [
          ...new Set([
            ...action.message.label_ids.filter((id) => id === label.id || !stale.includes(id)),
            label.id,
          ]),
        ],
      },
    });
    if (!approved.gmail_label_id) {
      await prisma.user_labels.update({
        where: { id: approved.id },
        data: { gmail_label_id: label.id },
      });
    }
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

  /**
   * One run, end to end: refresh the mailbox, classify what is new into facets, then project every
   * classification onto Gmail through the canonical pivot.
   *
   * This is the whole of card 12. There used to be a second, complete filing engine here — a
   * Gemini call per batch that chose a leaf of the approved tree, applied through an ADDITIVE
   * `messages.modify`. It was the engine the scheduler ran unattended every fifteen minutes, and
   * it was actively mis-filing: a Coursera course email sat in `Finance/Transactions/Failed
   * payments`, a folder only the retired planner could have spelled. Two engines writing the same
   * table and the same labels could always undo each other; now there is one.
   *
   * Neither facet service is called while this holds a lease, because each takes the same
   * account-scoped lease itself. That is also why the schedule is stamped afterwards rather than
   * on the way out of a lease this no longer owns.
   */
  private async execute(
    accountId: string,
    userId: string,
    trigger: automation_trigger,
    report?: ProgressReporter,
  ): Promise<RunOutcomeSummary> {
    if (!env.AUTOMATION_ENABLED) {
      throw new AppError('AUTOMATION_DISABLED', 'Daily automation is disabled.', 503);
    }
    if (!env.GEMINI_API_KEY) {
      throw new AppError('AUTOMATION_NOT_CONFIGURED', 'Gemini is not configured.', 503);
    }
    await auditService.record({
      action: 'automation.run.started',
      result: 'INFO',
      userId,
      metadata: { trigger },
    });

    try {
      await this.refreshMailbox(userId);
      const classified = await this.classification.classifyAccount(accountId);
      await report?.({
        processed: classified.ruleDecided + classified.modelDecided,
        total: classified.messagesSeen,
      });

      /*
       * Filing is opt-in now, and off by default. What runs unattended is classification alone:
       * the PWA builds its folders from `message_facets`, so mail classified tonight is in its
       * folder tonight without a single `messages.modify`. Turning `GMAIL_WRITE_ENABLED` on adds
       * the projection onto Gmail back to the end of the same run.
       *
       * When it does run it runs even if classification stopped early — it spends no tokens and
       * makes no model call, so mail that IS classified belongs in its folder tonight.
       */
      const filed = env.GMAIL_WRITE_ENABLED
        ? await this.filing.fileAccount(accountId, userId)
        : null;

      /*
       * What classification spent goes onto one run row, so one run is one row.
       *
       * Nothing else records it. `status().usageToday` sums these columns across today's runs,
       * and the classifier's own daily cap reads the same sum — so leaving them unwritten would
       * both blank the usage panel and hand every run of the day a fresh full allowance. Filing
       * used to open that row; with filing off there is nobody left to open it, which is why a
       * classification-only run opens its own.
       */
      const runId = filed?.runId ?? (await this.openClassificationRun(accountId, trigger));
      await prisma.automation_runs.update({
        where: { id: runId },
        data: {
          trigger,
          ...(filed
            ? {}
            : {
                status: classified.failed > 0 || classified.stoppedReason ? 'PARTIAL' : 'COMPLETED',
                completed_at: new Date(),
                messages_seen: classified.messagesSeen,
                failed_count: classified.failed,
              }),
          ai_classified_count: classified.modelDecided,
          pattern_reused_count: classified.ruleDecided,
          provider_call_count: classified.providerCalls,
          input_tokens: classified.usage.inputTokens,
          cached_input_tokens: classified.usage.cachedInputTokens,
          output_tokens: classified.usage.outputTokens,
          estimated_cost_microusd: classified.costMicrousd,
          stopped_reason: classified.stoppedReason,
          last_error_code: classified.lastErrorCode,
        },
      });

      const stoppedReason = classified.stoppedReason;
      const lastErrorCode = classified.lastErrorCode;
      const failed = classified.failed + (filed?.failed ?? 0);
      const status = failed > 0 || stoppedReason ? 'PARTIAL' : 'COMPLETED';
      await this.stampSchedule(accountId, status, lastErrorCode);

      const counters = this.countersOf(classified, filed);
      await auditService.record({
        action: 'automation.run.completed',
        result: status === 'COMPLETED' ? 'SUCCESS' : 'FAILURE',
        userId,
        metadata: { status, ...counters },
      });
      return {
        success: status === 'COMPLETED',
        // One row for the whole run, whichever half opened it. The Activity screen links to it.
        runId,
        status,
        stoppedReason,
        lastErrorCode,
        counters,
      };
    } catch (error) {
      const failureCode = errorCode(error);
      await this.stampSchedule(accountId, 'FAILED', failureCode);
      logger.error({ ...safeErrorDetails(error), accountId }, 'automation run failed');
      await auditService.record({
        action: 'automation.run.failed',
        result: 'FAILURE',
        userId,
        metadata: { errorCode: failureCode },
      });
      throw error instanceof AppError
        ? error
        : new AppError('AUTOMATION_FAILED', 'Mail automation failed safely.', 500);
    }
  }

  /**
   * Opens the run row a classification-only run reports into.
   *
   * Filing used to open it for both halves. With Gmail out of the write path there is no filing
   * half on a normal night, and the usage columns still have to land somewhere: the daily token
   * and cost caps are read back as a sum over today's rows.
   */
  private async openClassificationRun(
    accountId: string,
    trigger: automation_trigger,
  ): Promise<string> {
    const run = await prisma.automation_runs.create({
      data: {
        connected_google_account_id: accountId,
        idempotency_key: `${accountId}:facet-classification:${randomUUID()}`,
        trigger,
      },
    });
    return run.id;
  }

  /**
   * The one view of a run, and the one the Activity screen renders.
   *
   * `filed` is null on a run that only classified, which is every run unless writing to Gmail was
   * turned on. The filing counters are then zero rather than absent: a screen that has rendered
   * "0 filed" every night reads correctly, where a missing key would render nothing at all.
   */
  private countersOf(
    classified: FacetRunCounters,
    filed: FilingCounters | null,
  ): Record<string, number> {
    return {
      messagesSeen: filed?.seen ?? classified.messagesSeen,
      messagesClassified: classified.ruleDecided + classified.modelDecided,
      ruleDecided: classified.ruleDecided,
      modelDecided: classified.modelDecided,
      crossEntityRuleHits: classified.crossEntityRuleHits,
      messagesLabeled: filed?.filed ?? 0,
      reviewRequired: filed?.reviewRequired ?? 0,
      noLabelSkipped: filed?.none ?? 0,
      staleLabelsRemoved: filed?.staleLabelsRemoved ?? 0,
      labelsCreated: filed?.labelsCreated ?? 0,
      labelsReused: filed?.labelsReused ?? 0,
      failed: classified.failed + (filed?.failed ?? 0),
      providerCalls: classified.providerCalls,
      estimatedCostMicrousd: classified.costMicrousd,
    };
  }

  /**
   * When the scheduler should come back. Kept out of the lease entirely: the facet services own
   * the lease now, and this runs after they have both released it.
   *
   * A rate limit that survived pacing and retries means the daily request cap, which only resets
   * at midnight Pacific, so it backs off an hour instead of re-failing every tick. Anything else
   * gets fifteen minutes. A run that stopped at the daily token budget has no error code and waits
   * for the next scheduled hour, because that budget is daily and cumulative — a retry in fifteen
   * minutes would reach the same wall.
   */
  private async stampSchedule(
    accountId: string,
    status: 'COMPLETED' | 'PARTIAL' | 'FAILED',
    lastErrorCode: string | null,
  ): Promise<void> {
    await prisma.automation_states.upsert({
      where: { connected_google_account_id: accountId },
      create: {
        connected_google_account_id: accountId,
        next_run_at: nextDailyRun(env.AUTOMATION_SCHEDULE_HOUR_UTC),
      },
      update: {
        last_run_completed_at: new Date(),
        ...(status === 'COMPLETED'
          ? { last_successful_run_at: new Date(), failure_count: 0 }
          : { failure_count: { increment: 1 } }),
        last_error_code: lastErrorCode,
        retry_at:
          status !== 'COMPLETED' && lastErrorCode
            ? new Date(
                Date.now() +
                  (lastErrorCode === 'PROVIDER_RATE_LIMITED' ? 60 * 60_000 : 15 * 60_000),
              )
            : null,
        next_run_at: nextDailyRun(env.AUTOMATION_SCHEDULE_HOUR_UTC),
      },
    });
  }

  private unprocessedWhere(accountId: string) {
    return {
      connected_google_account_id: accountId,
      deleted_at: null,
      is_draft: false,
      is_sent: false,
      is_trashed: false,
      // Sync walks the mailbox with includeSpamTrash, so spam is stored like anything else, and
      // is_trashed alone does not exclude it — spam is not trash. Filing it would spend budget
      // classifying mail the user never chose to receive and inflate the no-fit rate with it.
      // The planner already excludes both; this makes the executor agree.
      NOT: { label_ids: { hasSome: ['SPAM', 'TRASH'] } },
      automationAction: null,
    };
  }

  private backlogCount(accountId: string): Promise<number> {
    return prisma.gmail_message_metadata.count({ where: this.unprocessedWhere(accountId) });
  }

  /**
   * Resolves the folder a reviewer chose, by full path or by leaf name.
   *
   * A leaf name stopped identifying one folder when the pivot arrived: a pivot repeats its lower
   * levels by construction, so "Payment failed" exists under every brand that has one. Picking the
   * first match would file the message into an arbitrary brand's folder, so an ambiguous name is
   * refused and the caller is told to send the full path instead.
   */
  private async approvedLabel(accountId: string, selector: string): Promise<user_labels> {
    const byPath = await prisma.user_labels.findFirst({
      where: { connected_google_account_id: accountId, full_path: selector },
    });
    if (byPath) return byPath;

    const matches = await prisma.user_labels.findMany({
      where: { connected_google_account_id: accountId, leaf_name: selector },
      orderBy: [{ depth: 'asc' }, { full_path: 'asc' }],
      take: 2,
    });
    if (matches.length > 1) {
      throw new AppError(
        'AUTOMATION_VALIDATION_FAILED',
        'Several folders share that name. Send the full path instead.',
        400,
      );
    }
    const label = matches[0];
    if (!label) {
      throw new AppError(
        'AUTOMATION_LABEL_NOT_APPROVED',
        'That label is not part of the approved set for this account.',
        400,
      );
    }
    return label;
  }

  /**
   * The MailMind labels a message is currently wearing, out of the ids it carries.
   *
   * A message holds one MailMind label or none, so re-filing has to know what to take off before
   * it puts something on. Non-MailMind labels are never touched: they are the user's own.
   */
  private async currentMailMindLabelIds(
    accountId: string,
    messageLabelIds: string[],
  ): Promise<string[]> {
    if (messageLabelIds.length === 0) return [];
    const labels = await prisma.gmail_labels.findMany({
      where: {
        connected_google_account_id: accountId,
        gmail_label_id: { in: messageLabelIds },
        name: { startsWith: `${LABEL_ROOT}/` },
      },
      select: { gmail_label_id: true },
    });
    return labels.map((label) => label.gmail_label_id);
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
