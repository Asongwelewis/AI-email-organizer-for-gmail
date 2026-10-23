import type { activity_runs, connected_google_accounts } from '@prisma/client';

import { auditService } from '@api/audit/audit.service.js';
import { env } from '@api/config/env.js';
import { logger, safeErrorDetails } from '@api/config/logger.js';
import { prisma } from '@api/database/prisma.js';
import { AppError } from '@api/errors/AppError.js';
import {
  activityRepository,
  type ActivityRepository,
} from '@api/features/activity/activity.repository.js';
import {
  activityService,
  type ActivityService,
  type ProgressReporter,
  type RunOutcome,
  type StartedRun,
} from '@api/features/activity/activity.service.js';
import {
  facetClassificationService,
  type FacetClassificationService,
  type FacetRunCounters,
} from '@api/features/automation/facet-classification.service.js';
import { recordDailyUsage } from '@api/features/automation/usage-ledger.js';
import {
  accountPolicies,
  type AccountPolicySource,
} from '@api/features/accounts/account-policy.js';
import {
  facetVocabularyRepository,
  type FacetVocabularyRepository,
} from '@api/features/label-discovery/facet-vocabulary.repository.js';
import {
  APPROVED_FACET_VOCABULARY,
  MODEL_FACET_NAMES,
} from '@api/features/label-discovery/facets.js';
import { gmailRepository } from '@api/integrations/gmail/gmail.repository.js';
import { gmailSyncService } from '@api/integrations/gmail/gmail.service.js';

/**
 * A new mailbox's first setup, from "Gmail connected" to "your folders are ready", with nobody
 * pressing a button in between.
 *
 * It used to be four manual steps — start a sync, propose a vocabulary, approve it, run the
 * classifier — and only the first had a button. A friend who connected Gmail saw nothing sorted and
 * an error about a missing Gemini key: the vocabulary step had no screen at all, so the classifier
 * refused with FACET_VOCABULARY_NOT_APPROVED, and the one message that reached the screen was the
 * operator's. Now connecting Gmail starts this, and the PWA shows its progress:
 *
 *   SYNCING  — the recent mail, bounded by GMAIL_INITIAL_SYNC_LOOKBACK_DAYS / _MAX_MESSAGES.
 *   LEARNING — the categories mail is sorted into. A new mailbox is given the starter vocabulary,
 *              approved on the person's behalf — the step that used to wait on a screen that did
 *              not exist. It is still theirs to change: the propose → approve endpoints stand.
 *   SORTING  — the newest ONBOARDING_SORT_LIMIT messages, which is what fills the first folders.
 *   DONE     — the watcher and the full runs take over: new mail as it lands, the backlog twice a
 *              day. Until then they stand aside, because two writers on one first sync only fight
 *              over the same leases.
 *
 * Each stage is skipped when its work is already done, so a run that stopped — a restart, the
 * shared Gemini budget, a key the operator has not set yet — resumes where it left off. Nobody has
 * to resume it: the scheduler's sweep starts it again (see `pendingAccounts`).
 */

export type OnboardingStage = 'SYNCING' | 'LEARNING' | 'SORTING' | 'DONE';

export type OnboardingState = 'PENDING' | 'RUNNING' | 'STOPPED' | 'FAILED' | 'DONE';

export interface OnboardingStatus {
  state: OnboardingState;
  stage: OnboardingStage | null;
  processed: number;
  total: number | null;
  /** Messages sorted so far, across the whole of onboarding. */
  sorted: number;
  /** Why it stopped, in words for the person reading it. Null while it is going well. */
  message: string | null;
  stopReason: string | null;
  runId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  completedAt: string | null;
}

/** Messages one classification pass takes, so progress is reported and usage recorded as it goes. */
const SORT_PASS_SIZE = 100;

/** Messages a rules-only pass takes: no model, so only progress reporting bounds it. */
const RULES_PASS_SIZE = 2000;

/** Gemini calls in flight for one onboarding. The pacer still spaces their starts. */
const SORT_CONCURRENCY = 3;

/** A stopped onboarding is tried again after this long. */
const RETRY_AFTER_MS = 5 * 60_000;

/** How long a run waits for a free slot before giving it up to the sweep. */
const SLOT_WAIT_MS = 4 * 60_000;

/**
 * What a stopped onboarding tells the person. Written for whoever signed up, not for the operator:
 * the reasons that need the operator say that it is being handled, because from where they sit
 * there is nothing else to do.
 */
const STOP_MESSAGES: Record<string, string> = {
  SORTING_NOT_CONFIGURED:
    'Your mail is synced. Sorting has not been switched on for AMO yet — it will start on its own as soon as it is.',
  SHARED_DAILY_LIMIT_REACHED:
    'AMO has sorted as much mail as it can today. Yours is next in line and will continue automatically.',
  DAILY_BUDGET_REACHED:
    'AMO has sorted as much mail as it can today. Yours is next in line and will continue automatically.',
  PROVIDER_RATE_LIMITED:
    'Lots of people are setting up right now. Sorting will pick up again in a few minutes.',
  PROVIDER_UNUSABLE: 'Sorting hit a problem. It will try again in a few minutes.',
  DATABASE_UNAVAILABLE: 'AMO could not save its progress. It will try again in a few minutes.',
  WAITING_FOR_SYNC: 'Your mail is still being read. Sorting starts as soon as that finishes.',
  WAITING_FOR_SLOT: 'A few people are setting up at once. Yours starts in a moment.',
  GMAIL_REAUTH_REQUIRED: 'AMO lost access to Gmail. Reconnect Gmail to carry on.',
  GMAIL_PERMISSION_DENIED:
    'Gmail did not give AMO permission to read your mail. Reconnect Gmail and allow access to carry on.',
};

const FAILED_MESSAGE = 'Setting up hit a problem. It will try again in a few minutes.';

function stopMessage(reason: string | null): string | null {
  if (!reason) return null;
  return STOP_MESSAGES[reason] ?? FAILED_MESSAGE;
}

class Slots {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly size: () => number) {}

  get free(): number {
    return Math.max(0, this.size() - this.active);
  }

  /** Resolves true with a slot held, or false if none came free within `timeoutMs`. */
  acquire(timeoutMs: number, heartbeat: () => Promise<void>): Promise<boolean> {
    if (this.active < this.size()) {
      this.active += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const beat = setInterval(() => void heartbeat().catch(() => undefined), 60_000);
      const timer = setTimeout(() => {
        clearInterval(beat);
        const position = this.waiters.indexOf(grant);
        if (position >= 0) this.waiters.splice(position, 1);
        resolve(false);
      }, timeoutMs);
      const grant = () => {
        clearInterval(beat);
        clearTimeout(timer);
        this.active += 1;
        resolve(true);
      };
      this.waiters.push(grant);
    });
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    this.waiters.shift()?.();
  }
}

export class OnboardingService {
  private readonly slots = new Slots(() => env.ONBOARDING_CONCURRENCY);

  constructor(
    private readonly activity: ActivityService = activityService,
    private readonly accounts: ActivityRepository = activityRepository,
    private readonly classification: Pick<
      FacetClassificationService,
      'classifyAccount'
    > = facetClassificationService,
    private readonly vocabularies: FacetVocabularyRepository = facetVocabularyRepository,
    private readonly gmail: Pick<typeof gmailSyncService, 'initialSync'> = gmailSyncService,
    private readonly policies: AccountPolicySource = accountPolicies,
  ) {}

  /**
   * Starts onboarding for this person's mailbox, or joins the run already going. Null when there
   * is nothing to do because it finished. Safe to call as often as anyone likes: the activity run
   * is the one live slot per mailbox.
   */
  async begin(
    userId: string,
    trigger: 'MANUAL' | 'SCHEDULED' = 'MANUAL',
  ): Promise<StartedRun | null> {
    const account = await this.accounts.activeAccountForUser(userId);
    if (account.onboarding_completed_at) return null;
    const started = await this.activity.start({
      accountId: account.id,
      kind: 'ONBOARDING',
      trigger,
    });
    if (!started.alreadyRunning) {
      this.activity.runDetached(started.runId, (report) => this.run(account, userId, report));
    }
    return started;
  }

  async status(userId: string): Promise<OnboardingStatus> {
    const account = await this.accounts.activeAccountForUser(userId);
    const run = await prisma.activity_runs.findFirst({
      where: { connected_google_account_id: account.id, kind: 'ONBOARDING' },
      orderBy: { started_at: 'desc' },
    });
    return this.describe(account, run);
  }

  /**
   * Mailboxes the sweep should start: connected, not finished, with no onboarding running, and
   * either never tried or last tried more than RETRY_AFTER_MS ago. Oldest connection first, and
   * never more than there are free slots on this instance.
   */
  async pendingAccounts(now = new Date()): Promise<Array<{ id: string; user_id: string }>> {
    const free = this.slots.free;
    if (free === 0) return [];
    const retryBefore = new Date(now.getTime() - RETRY_AFTER_MS);
    return prisma.connected_google_accounts.findMany({
      where: {
        gmail_connected: true,
        connection_status: 'CONNECTED',
        onboarding_completed_at: null,
        activity_runs: {
          none: {
            kind: 'ONBOARDING',
            OR: [
              { state: 'RUNNING', expires_at: { gt: now } },
              { finished_at: { gt: retryBefore } },
            ],
          },
        },
      },
      orderBy: { connected_at: 'asc' },
      select: { id: true, user_id: true },
      take: free,
    });
  }

  /** One pass of the sweep. Never throws: one mailbox that cannot start must not stop the rest. */
  async sweep(now = new Date()): Promise<number> {
    let started = 0;
    for (const account of await this.pendingAccounts(now)) {
      try {
        const run = await this.begin(account.user_id, 'SCHEDULED');
        if (run && !run.alreadyRunning) started += 1;
      } catch (error) {
        logger.warn(
          { ...safeErrorDetails(error), accountId: account.id },
          'onboarding could not be started',
        );
      }
    }
    return started;
  }

  private async run(
    account: connected_google_accounts,
    userId: string,
    report: ProgressReporter,
  ): Promise<RunOutcome> {
    const slot = await this.slots.acquire(SLOT_WAIT_MS, () => report({}));
    if (!slot) return { state: 'STOPPED', stopReason: 'WAITING_FOR_SLOT' };
    try {
      return await this.stages(account, userId, report);
    } finally {
      this.slots.release();
    }
  }

  private async stages(
    account: connected_google_accounts,
    userId: string,
    report: ProgressReporter,
  ): Promise<RunOutcome> {
    // 1. Read the recent mail.
    const syncState = await gmailRepository.state(account.id);
    if (!syncState?.initial_sync_completed_at) {
      await this.setStage(account.id, 'SYNCING');
      await report({ processed: 0, total: null });
      try {
        await this.gmail.initialSync(userId, (progress) =>
          report({ processed: progress.processed ?? 0, total: progress.total ?? null }),
        );
      } catch (error) {
        if (error instanceof AppError && error.code === 'GMAIL_SYNC_ALREADY_RUNNING') {
          return { state: 'STOPPED', stopReason: 'WAITING_FOR_SYNC' };
        }
        // Both are about the grant, so the answer is the person reconnecting, not a retry.
        if (
          error instanceof AppError &&
          (error.code === 'GMAIL_REAUTH_REQUIRED' || error.code === 'GMAIL_PERMISSION_DENIED')
        ) {
          return { state: 'STOPPED', stopReason: error.code };
        }
        throw error;
      }
    }

    // 2. The categories mail is sorted into.
    await this.setStage(account.id, 'LEARNING');
    await report({ processed: 0, total: null });
    await this.ensureVocabulary(account.id, userId);

    // 3. Sort the newest mail.
    await this.setStage(account.id, 'SORTING');
    const sorting = await this.sortRecent(account.id, report);
    // Something sorted is enough to open the folders; the full runs finish the rest. Nothing
    // sorted and a reason to stop means the person would see an empty Inbox, so it stays pending
    // and the sweep tries again.
    if (sorting.sorted === 0 && sorting.stopReason) {
      return {
        state: 'STOPPED',
        stopReason: sorting.stopReason,
        processed: 0,
        total: sorting.total,
        counts: { sorted: 0 },
      };
    }

    // 4. Hand over to the watcher and the full runs.
    await prisma.connected_google_accounts.update({
      where: { id: account.id },
      data: { onboarding_stage: 'DONE', onboarding_completed_at: new Date() },
    });
    return {
      state: 'SUCCEEDED',
      processed: sorting.sorted,
      total: sorting.total,
      counts: { sorted: sorting.sorted },
    };
  }

  /**
   * Approves the starter vocabulary for a mailbox that has none. A mailbox that approved its own
   * keeps it: this only ever fills a gap.
   */
  private async ensureVocabulary(accountId: string, userId: string): Promise<void> {
    const approved = await this.vocabularies.approved(accountId);
    if (approved.domain.length > 0 && approved.intent.length > 0) return;
    const values = MODEL_FACET_NAMES.flatMap((facet) =>
      APPROVED_FACET_VOCABULARY[facet].map((value) => ({
        facet,
        name: value.name,
        definition: value.definition,
      })),
    );
    const result = await this.vocabularies.approve(accountId, values);
    await auditService.record({
      action: 'facets.vocabulary.approved',
      result: 'SUCCESS',
      userId,
      metadata: {
        automatic: true,
        domainValues: result.domain.length,
        intentValues: result.intent.length,
      },
    });
  }

  private async sortRecent(
    accountId: string,
    report: ProgressReporter,
  ): Promise<{ sorted: number; total: number; stopReason: string | null }> {
    const policy = await this.policies.forAccount(accountId);
    // Sorting by rules costs nothing but database time, so a rules-sorted mailbox is sorted
    // to the end of its window here: nothing it holds is left unsorted when setup says done.
    // The model's share of the day is what bounds the owner's.
    const rulesOnly = policy.mode === 'RULES';
    const waiting = await this.unsortedCount(accountId, policy.windowStart);
    const total = rulesOnly ? waiting : Math.min(env.ONBOARDING_SORT_LIMIT, waiting);
    let sorted = 0;
    await report({ processed: 0, total });
    while (sorted < total) {
      const before = sorted;
      const counters: FacetRunCounters = await this.classification.classifyAccount(accountId, {
        scope: 'backlog',
        limit: Math.min(rulesOnly ? RULES_PASS_SIZE : SORT_PASS_SIZE, total - sorted),
        priority: 'onboarding',
        batchSize: 25,
        concurrency: SORT_CONCURRENCY,
        onProgress: (progress) =>
          report({
            processed: Math.min(total, before + progress.ruleDecided + progress.modelDecided),
            total,
          }),
      });
      await recordDailyUsage(accountId, 'onboarding', counters);
      const decided = counters.ruleDecided + counters.modelDecided;
      sorted += decided;
      await report({ processed: Math.min(total, sorted), total });
      if (counters.stoppedReason) return { sorted, total, stopReason: counters.stoppedReason };
      // A pass that sorted nothing and stopped for no reason has run out of mail it can sort.
      if (decided === 0) break;
    }
    return { sorted, total, stopReason: null };
  }

  private unsortedCount(accountId: string, windowStart: Date | null): Promise<number> {
    return prisma.gmail_message_metadata.count({
      where: {
        connected_google_account_id: accountId,
        deleted_at: null,
        ...(windowStart ? { internal_date: { gte: windowStart } } : {}),
        is_draft: false,
        is_sent: false,
        is_trashed: false,
        facets: null,
        NOT: { label_ids: { hasSome: ['SPAM', 'TRASH', 'DRAFT'] } },
      },
    });
  }

  private async setStage(accountId: string, stage: OnboardingStage): Promise<void> {
    await prisma.connected_google_accounts.update({
      where: { id: accountId },
      data: { onboarding_stage: stage },
    });
  }

  private describe(
    account: connected_google_accounts,
    run: activity_runs | null,
  ): OnboardingStatus {
    const sorted = ((run?.counts ?? {}) as Record<string, number>)['sorted'] ?? 0;
    const base = {
      stage: (account.onboarding_stage as OnboardingStage | null) ?? null,
      processed: run?.processed_count ?? 0,
      total: run?.total_count ?? null,
      sorted,
      runId: run?.id ?? null,
      startedAt: run?.started_at.toISOString() ?? null,
      finishedAt: run?.finished_at?.toISOString() ?? null,
      completedAt: account.onboarding_completed_at?.toISOString() ?? null,
    };
    if (account.onboarding_completed_at) {
      return { ...base, state: 'DONE', stage: 'DONE', message: null, stopReason: null };
    }
    if (!run) return { ...base, state: 'PENDING', message: null, stopReason: null };
    if (run.state === 'RUNNING') {
      return { ...base, state: 'RUNNING', message: null, stopReason: null };
    }
    if (run.state === 'STOPPED') {
      return {
        ...base,
        state: 'STOPPED',
        message: stopMessage(run.stop_reason),
        stopReason: run.stop_reason,
      };
    }
    // SUCCEEDED without a completion stamp only happens if the final write was lost, and FAILED is
    // a problem the sweep retries. Either way the person reads the same thing.
    return { ...base, state: 'FAILED', message: FAILED_MESSAGE, stopReason: run.error_code };
  }
}

export const onboardingService = new OnboardingService();
