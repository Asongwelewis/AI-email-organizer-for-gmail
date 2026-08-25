import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The unattended path. Every run before this suite was triggered by hand, so nothing here — the
 * tick, the lease, the backoff, the ending a person reads the next morning — had ever been
 * exercised. A silent overnight failure is the specific thing these tests exist to prevent.
 */
const mocks = vi.hoisted(() => {
  const transactionStateUpdate = vi.fn();
  const transactionRunUpdate = vi.fn();
  return {
    eligibleScheduledAccounts: vi.fn(),
    runScheduledAccount: vi.fn(),
    captureApiException: vi.fn(),
    loggerError: vi.fn(),
    auditRecord: vi.fn(),
    incrementalSync: vi.fn(),
    initialSync: vi.fn(),
    connectedAccount: vi.fn(),
    accountFindMany: vi.fn(),
    settingsUpsert: vi.fn(),
    stateUpsert: vi.fn(),
    stateUpdateMany: vi.fn(),
    runUpdateMany: vi.fn(),
    runCreate: vi.fn(),
    runFindUnique: vi.fn(),
    runAggregate: vi.fn(),
    actionFindMany: vi.fn(),
    actionCreate: vi.fn(),
    actionUpdate: vi.fn(),
    actionFindUniqueOrThrow: vi.fn(),
    messageFindMany: vi.fn(),
    messageCount: vi.fn(),
    messageUpdate: vi.fn(),
    userLabelFindMany: vi.fn(),
    userLabelCount: vi.fn(),
    patternFindMany: vi.fn(),
    patternFindUnique: vi.fn(),
    patternUpsert: vi.fn(),
    classifier: vi.fn(),
    activityStart: vi.fn(),
    activityRunDetached: vi.fn(),
    activityRunToCompletion: vi.fn(),
    activityFinishRun: vi.fn(),
    transactionStateUpdate,
    transactionRunUpdate,
    transaction: vi.fn(async (callback: (transaction: unknown) => unknown) =>
      callback({
        automation_states: { updateMany: transactionStateUpdate },
        automation_runs: { update: transactionRunUpdate },
      }),
    ),
  };
});

vi.mock('../src/audit/audit.service.js', () => ({
  auditService: { record: mocks.auditRecord },
}));
vi.mock('../src/observability/sentry.js', () => ({
  captureApiException: mocks.captureApiException,
}));
vi.mock('../src/config/logger.js', () => ({
  logger: { error: mocks.loggerError, warn: vi.fn(), info: vi.fn() },
  safeErrorDetails: () => ({ errorType: 'Error' }),
}));
vi.mock('../src/features/activity/activity.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/features/activity/activity.service.js')
  >('../src/features/activity/activity.service.js');
  return {
    ...actual,
    activityService: {
      start: mocks.activityStart,
      runDetached: mocks.activityRunDetached,
      runToCompletion: mocks.activityRunToCompletion,
      finishRun: mocks.activityFinishRun,
    },
  };
});
vi.mock('../src/integrations/gmail/gmail.service.js', () => ({
  gmailSyncService: {
    incrementalSync: mocks.incrementalSync,
    initialSync: mocks.initialSync,
  },
}));
vi.mock('../src/database/prisma.js', () => ({
  prisma: {
    connected_google_accounts: {
      findFirst: mocks.connectedAccount,
      findMany: mocks.accountFindMany,
    },
    automation_settings: { upsert: mocks.settingsUpsert },
    automation_states: { upsert: mocks.stateUpsert, updateMany: mocks.stateUpdateMany },
    automation_runs: {
      updateMany: mocks.runUpdateMany,
      create: mocks.runCreate,
      findUnique: mocks.runFindUnique,
      aggregate: mocks.runAggregate,
    },
    automation_message_actions: {
      findMany: mocks.actionFindMany,
      findFirst: vi.fn(),
      create: mocks.actionCreate,
      update: mocks.actionUpdate,
      findUniqueOrThrow: mocks.actionFindUniqueOrThrow,
    },
    gmail_labels: { findMany: vi.fn() },
    gmail_message_metadata: {
      findMany: mocks.messageFindMany,
      count: mocks.messageCount,
      update: mocks.messageUpdate,
    },
    user_labels: {
      findMany: mocks.userLabelFindMany,
      findFirst: vi.fn(),
      count: mocks.userLabelCount,
      update: vi.fn(),
    },
    learned_classification_patterns: {
      findMany: mocks.patternFindMany,
      findUnique: mocks.patternFindUnique,
      upsert: mocks.patternUpsert,
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: mocks.transaction,
  },
}));

import { env } from '../src/config/env.js';
import { AppError } from '../src/errors/AppError.js';
import type { RunOutcome } from '../src/features/activity/activity.service.js';
import { AutomationService } from '../src/features/automation/automation.service.js';
import { GeminiProviderError } from '../src/features/automation/gemini-automation.provider.js';

const approvedLabel = {
  id: 'label-1',
  connected_google_account_id: 'account-1',
  leaf_name: 'Invoices',
  full_path: 'MailMind/Invoices',
  normalized_name: 'invoices',
  source: 'AI_PROPOSED',
  gmail_label_id: 'Label_1',
};

const gmailStub = () => ({
  ensureLabel: vi.fn().mockResolvedValue({ id: 'Label_1', created: false }),
  applyLabel: vi.fn().mockResolvedValue(undefined),
  applyExclusiveLabel: vi.fn().mockResolvedValue(undefined),
  renameLabel: vi.fn().mockResolvedValue(undefined),
});

const classification = () => ({
  classifications: [
    {
      key: 'm1',
      labelName: 'Invoices',
      confidence: 0.97,
      explanation: 'Billing terms are present.',
      reasonCodes: ['INVOICE_TERMS'],
    },
  ],
  usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
});

/** The data a $transaction state update was called with, which is where backoff is recorded. */
function releasedState(): Record<string, unknown> {
  const call = mocks.transactionStateUpdate.mock.calls.at(-1)?.[0] as
    { data: Record<string, unknown> } | undefined;
  return call?.data ?? {};
}

describe('automation scheduler tick', () => {
  const originalProcessEnv = { ...process.env };

  beforeEach(() => {
    // The scheduler is re-imported per test, and it pulls in a fresh config module with it, so
    // the gating flags have to be set on process.env rather than on the env object above.
    vi.resetModules();
    vi.clearAllMocks();
    process.env['AUTOMATION_ENABLED'] = 'true';
    process.env['GEMINI_API_KEY'] = 'test-gemini-key';
    mocks.eligibleScheduledAccounts.mockResolvedValue([]);
    mocks.runScheduledAccount.mockResolvedValue({ success: true });
    vi.doMock('../src/features/automation/automation.service.js', () => ({
      automationService: {
        eligibleScheduledAccounts: mocks.eligibleScheduledAccounts,
        runScheduledAccount: mocks.runScheduledAccount,
      },
    }));
  });

  afterEach(async () => {
    const scheduler = await import('../src/features/automation/automation.scheduler.js');
    scheduler.stopAutomationScheduler();
    vi.useRealTimers();
    vi.doUnmock('../src/features/automation/automation.service.js');
    process.env = { ...originalProcessEnv };
  });

  /** A fresh copy each time, so one test's timer and `ticking` flag cannot reach the next. */
  async function loadScheduler() {
    const scheduler = await import('../src/features/automation/automation.scheduler.js');
    const { env: loaded } = await import('../src/config/env.js');
    return { ...scheduler, pollIntervalMs: loaded.AUTOMATION_POLL_INTERVAL_MINUTES * 60_000 };
  }

  // The mitigation the board relies on while the two filing engines are not yet unified. If the
  // flag did not actually stop the timer there would be nothing standing between a deployed API
  // and unattended mis-filing.
  it('starts no timer at all when automation is disabled', async () => {
    process.env['AUTOMATION_ENABLED'] = 'false';
    vi.useFakeTimers();
    const { startAutomationScheduler, pollIntervalMs } = await loadScheduler();

    startAutomationScheduler();
    await vi.advanceTimersByTimeAsync(pollIntervalMs * 3);

    expect(mocks.eligibleScheduledAccounts).not.toHaveBeenCalled();
  });

  it('does not run unattended without a Gemini key, which no run could use anyway', async () => {
    delete process.env['GEMINI_API_KEY'];
    vi.useFakeTimers();
    const { startAutomationScheduler } = await loadScheduler();

    startAutomationScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.eligibleScheduledAccounts).not.toHaveBeenCalled();
  });

  it('catches up immediately on boot and then polls on the configured interval', async () => {
    vi.useFakeTimers();
    const { startAutomationScheduler, pollIntervalMs } = await loadScheduler();

    startAutomationScheduler();
    // A restart must not wait a full interval before looking: the tick after a deploy is the one
    // that picks up everything the process missed while it was down.
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.eligibleScheduledAccounts).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(pollIntervalMs);
    expect(mocks.eligibleScheduledAccounts).toHaveBeenCalledTimes(2);
  });

  it('skips a tick that would overlap a run still in flight', async () => {
    let release: (() => void) | undefined;
    mocks.eligibleScheduledAccounts.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve([]);
      }),
    );
    vi.useFakeTimers();
    const { startAutomationScheduler, pollIntervalMs } = await loadScheduler();

    startAutomationScheduler();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(pollIntervalMs * 2);

    // Two intervals elapsed while the first tick was still working. Neither started a rival tick.
    expect(mocks.eligibleScheduledAccounts).toHaveBeenCalledTimes(1);
    release?.();
  });

  it('carries on to the next account when one throws, and records the failure', async () => {
    mocks.eligibleScheduledAccounts.mockResolvedValue([
      { id: 'account-1', user_id: 'user-1' },
      { id: 'account-2', user_id: 'user-2' },
    ]);
    mocks.runScheduledAccount
      .mockRejectedValueOnce(new Error('gmail exploded'))
      .mockResolvedValueOnce({ success: true });
    vi.useFakeTimers();
    const { startAutomationScheduler } = await loadScheduler();

    startAutomationScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.runScheduledAccount).toHaveBeenNthCalledWith(1, 'account-1', 'user-1');
    expect(mocks.runScheduledAccount).toHaveBeenNthCalledWith(2, 'account-2', 'user-2');
    // Unattended means nobody is holding a response open, so the only trace is the log and Sentry.
    expect(mocks.captureApiException).toHaveBeenCalledWith(expect.any(Error), {
      operation: 'scheduled_automation_account',
    });
    expect(mocks.loggerError).toHaveBeenCalled();
  });

  it('survives a tick that fails outright and ticks again on the next interval', async () => {
    mocks.eligibleScheduledAccounts
      .mockRejectedValueOnce(new Error('database unreachable'))
      .mockResolvedValue([]);
    vi.useFakeTimers();
    const { startAutomationScheduler, pollIntervalMs } = await loadScheduler();

    startAutomationScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.captureApiException).toHaveBeenCalledWith(expect.any(Error), {
      operation: 'scheduled_automation_tick',
    });

    // The ticking guard has to be released on the failure path too, or one bad tick ends the day.
    await vi.advanceTimersByTimeAsync(pollIntervalMs);
    expect(mocks.eligibleScheduledAccounts).toHaveBeenCalledTimes(2);
  });

  it('starts only one timer however many times it is started', async () => {
    vi.useFakeTimers();
    const { startAutomationScheduler, pollIntervalMs } = await loadScheduler();

    startAutomationScheduler();
    startAutomationScheduler();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(pollIntervalMs);

    expect(mocks.eligibleScheduledAccounts).toHaveBeenCalledTimes(2);
  });
});

describe('which accounts a tick picks up', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accountFindMany.mockResolvedValue([]);
  });

  it('asks only for connected accounts that are due, by schedule or by backoff', async () => {
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await service.eligibleScheduledAccounts();

    const where = mocks.accountFindMany.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({ gmail_connected: true, connection_status: 'CONNECTED' });
    // An account whose settings row says disabled is excluded; a missing row means the default.
    expect(where.AND[0].OR).toEqual([
      { automation_settings: null },
      { automation_settings: { is: { enabled: true } } },
    ]);
    // Due by the daily schedule, or due because a stopped run asked to be retried sooner. A
    // never-run account has neither and is due immediately.
    const dueClauses = where.AND[1].OR;
    expect(dueClauses).toHaveLength(3);
    expect(dueClauses[0]).toEqual({ automation_state: null });
    expect(dueClauses[1].automation_state.is.next_run_at.lte).toBeInstanceOf(Date);
    expect(dueClauses[2].automation_state.is.retry_at.lte).toBeInstanceOf(Date);
  });
});

describe('an unattended run and how it ends', () => {
  const originalEnabled = env.AUTOMATION_ENABLED;
  const originalKey = env.GEMINI_API_KEY;
  let outcome: RunOutcome | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    outcome = undefined;
    env.AUTOMATION_ENABLED = true;
    env.GEMINI_API_KEY = 'test-gemini-key';
    mocks.settingsUpsert.mockResolvedValue({});
    mocks.stateUpsert.mockResolvedValue({ failure_count: 0 });
    mocks.stateUpdateMany.mockResolvedValue({ count: 1 });
    mocks.runUpdateMany.mockResolvedValue({ count: 0 });
    mocks.runCreate.mockResolvedValue({ id: 'run-1' });
    mocks.runAggregate.mockResolvedValue({
      _sum: { input_tokens: 0, output_tokens: 0, estimated_cost_microusd: 0 },
    });
    mocks.actionFindMany.mockResolvedValue([]);
    mocks.actionCreate.mockResolvedValue({ id: 'action-1' });
    mocks.actionUpdate.mockResolvedValue({});
    mocks.actionFindUniqueOrThrow.mockResolvedValue({
      gmail_message_id: 'message-row-1',
      message: { label_ids: [] },
    });
    mocks.messageUpdate.mockResolvedValue({});
    mocks.messageCount.mockResolvedValue(1);
    mocks.userLabelFindMany.mockResolvedValue([approvedLabel]);
    mocks.userLabelCount.mockResolvedValue(1);
    mocks.messageFindMany.mockResolvedValue([
      {
        id: 'message-row-1',
        gmail_message_id: 'gmail-message-1',
        subject: 'Invoice 22',
        sender_email: 'billing@example.com',
        snippet: 'Amount due',
        internal_date: new Date(),
        is_unread: true,
        is_important: false,
        has_attachments: false,
      },
    ]);
    mocks.patternFindMany.mockResolvedValue([]);
    mocks.patternFindUnique.mockResolvedValue(null);
    mocks.patternUpsert.mockResolvedValue({});
    mocks.incrementalSync.mockResolvedValue(undefined);
    mocks.initialSync.mockResolvedValue(undefined);
    mocks.transactionStateUpdate.mockResolvedValue({ count: 1 });
    mocks.transactionRunUpdate.mockResolvedValue({});
    mocks.classifier.mockResolvedValue(classification());
    mocks.activityStart.mockResolvedValue({
      runId: 'activity-run-1',
      state: 'RUNNING',
      kind: 'AUTOMATION_FILING',
      startedAt: '2026-08-25T02:00:00.000Z',
      alreadyRunning: false,
    });
    // Stand in for the real activity service: drive the work and keep the outcome it reports,
    // which is exactly what the Activity screen ends up rendering.
    mocks.activityRunToCompletion.mockImplementation(
      async (_runId: string, work: (report: unknown) => Promise<RunOutcome>) => {
        outcome = await work(async () => undefined);
      },
    );
  });

  afterEach(() => {
    env.AUTOMATION_ENABLED = originalEnabled;
    env.GEMINI_API_KEY = originalKey;
  });

  it('files under a SCHEDULED run record and waits for it, unlike the 202 path', async () => {
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await expect(service.runScheduledAccount('account-1', 'user-1')).resolves.toMatchObject({
      success: true,
      runId: 'activity-run-1',
    });

    expect(mocks.activityStart).toHaveBeenCalledWith({
      accountId: 'account-1',
      kind: 'AUTOMATION_FILING',
      trigger: 'SCHEDULED',
    });
    // The tick has no HTTP caller to poll, so it awaits the run rather than detaching it.
    expect(mocks.activityRunToCompletion).toHaveBeenCalled();
    expect(mocks.activityRunDetached).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ state: 'SUCCEEDED', stopReason: null });
  });

  it('joins a run already in flight instead of starting a rival one', async () => {
    mocks.activityStart.mockResolvedValue({
      runId: 'activity-run-1',
      state: 'RUNNING',
      kind: 'AUTOMATION_FILING',
      startedAt: '2026-08-25T02:00:00.000Z',
      alreadyRunning: true,
    });
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await expect(service.runScheduledAccount('account-1', 'user-1')).resolves.toMatchObject({
      status: 'RUNNING',
      runId: null,
    });
    expect(mocks.activityRunToCompletion).not.toHaveBeenCalled();
  });

  // Two API instances share one database, so the lease is what stops both filing the same mail.
  it('refuses to file when another instance holds the lease', async () => {
    mocks.stateUpdateMany.mockResolvedValue({ count: 0 });
    mocks.activityRunToCompletion.mockImplementation(
      async (_runId: string, work: (report: unknown) => Promise<RunOutcome>) => {
        await expect(work(async () => undefined)).rejects.toMatchObject({
          code: 'AUTOMATION_ALREADY_RUNNING',
        });
      },
    );
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await service.runScheduledAccount('account-1', 'user-1');

    expect(mocks.classifier).not.toHaveBeenCalled();
    expect(mocks.runCreate).not.toHaveBeenCalled();
  });

  // The other half of the lease, and the one that fails silently: if an expired lease could not
  // be taken over, a process killed mid-run would leave its token behind and every later tick
  // would refuse forever. Nothing would log, and filing would simply stop.
  it('takes over a lease whose holder died rather than waiting on it forever', async () => {
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await service.runScheduledAccount('account-1', 'user-1');

    const acquire = mocks.stateUpdateMany.mock.calls[0]?.[0];
    // Free, or held by a token whose expiry has passed. Nothing else may claim it.
    expect(acquire.where.OR).toEqual([
      { lease_expires_at: null },
      { lease_expires_at: { lt: expect.any(Date) } },
    ]);
    expect(acquire.where.connected_google_account_id).toBe('account-1');

    // And the claim it writes expires too, so this run cannot become the stuck holder either.
    const expiresAt = acquire.data.lease_expires_at as Date;
    const seconds = (expiresAt.getTime() - Date.now()) / 1000;
    expect(seconds).toBeGreaterThan(env.AUTOMATION_LEASE_SECONDS - 30);
    expect(seconds).toBeLessThanOrEqual(env.AUTOMATION_LEASE_SECONDS);
  });

  // A long backfill outlives one lease term, so the run has to keep renewing while it works.
  it('renews the lease as it goes, so a long run does not expire under itself', async () => {
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await service.runScheduledAccount('account-1', 'user-1');

    // The first call acquires the lease; a renewal is any later one that pushes the expiry out.
    const renewals = mocks.stateUpdateMany.mock.calls
      .slice(1)
      .filter(([query]) => query.data?.lease_expires_at);
    expect(renewals.length).toBeGreaterThan(0);
    for (const [query] of renewals) {
      // Scoped to this run's token AND to the lease still being live: a renewal must not
      // resurrect a lease that already lapsed and was taken over by another instance.
      expect(query.where.lease_token).toEqual(expect.any(String));
      expect(query.where.lease_expires_at).toEqual({ gt: expect.any(Date) });
    }
  });

  it('reports the run that already used this scheduled slot rather than filing twice', async () => {
    mocks.runCreate.mockRejectedValue(new Error('unique constraint on idempotency_key'));
    mocks.runFindUnique.mockResolvedValue({
      id: 'run-earlier-today',
      status: 'COMPLETED',
      stopped_reason: null,
      last_error_code: null,
    });
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await service.runScheduledAccount('account-1', 'user-1');

    expect(mocks.classifier).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ state: 'SUCCEEDED', featureRunId: 'run-earlier-today' });
  });

  it('schedules the next run at the configured hour and clears the backoff on success', async () => {
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await service.runScheduledAccount('account-1', 'user-1');

    const state = releasedState();
    expect(state['retry_at']).toBeNull();
    expect(state['failure_count']).toBe(0);
    expect(state['lease_token']).toBeNull();
    const nextRun = state['next_run_at'] as Date;
    expect(nextRun.getUTCHours()).toBe(env.AUTOMATION_SCHEDULE_HOUR_UTC);
    expect(nextRun.getUTCMinutes()).toBe(0);
    expect(nextRun.getTime()).toBeGreaterThan(Date.now());
  });

  // A surviving 429 means the daily request cap, which only resets at midnight Pacific. Retrying
  // every 15 minutes against a spent quota would just log the same failure 96 times.
  it('backs off an hour after a rate limit and leaves the run resumable', async () => {
    mocks.classifier.mockRejectedValue(
      new GeminiProviderError(
        'PROVIDER_RATE_LIMITED',
        'Gemini is rate limited.',
        503,
        429,
        'RESOURCE_EXHAUSTED',
        'request-safe-id',
        false,
      ),
    );
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await service.runScheduledAccount('account-1', 'user-1');

    const retryAt = releasedState()['retry_at'] as Date;
    const minutes = (retryAt.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(55);
    expect(minutes).toBeLessThanOrEqual(60);
    expect(outcome).toMatchObject({
      state: 'STOPPED',
      stopReason: 'PROVIDER_RATE_LIMITED',
      errorMessage:
        'Gemini rate-limited this run. Everything filed so far is saved and the rest resumes on the next scheduled run.',
    });
  });

  it('backs off fifteen minutes after any other provider fault', async () => {
    mocks.classifier.mockRejectedValue(new Error('malformed JSON'));
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await service.runScheduledAccount('account-1', 'user-1');

    const retryAt = releasedState()['retry_at'] as Date;
    const minutes = (retryAt.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(10);
    expect(minutes).toBeLessThanOrEqual(15);
  });

  // The token budgets are daily and cumulative since 00:00 UTC, so a budget stop has nothing left
  // to spend today. Retrying in 15 minutes would burn a tick to reach the same wall.
  it('waits for the next scheduled hour after the daily budget, not for the next tick', async () => {
    mocks.runAggregate.mockResolvedValue({
      _sum: {
        input_tokens: 0,
        output_tokens: env.AUTOMATION_MAX_OUTPUT_TOKENS - 50,
        estimated_cost_microusd: 0,
      },
    });
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await service.runScheduledAccount('account-1', 'user-1');

    expect(mocks.classifier).not.toHaveBeenCalled();
    const state = releasedState();
    expect(state['retry_at']).toBeNull();
    expect((state['next_run_at'] as Date).getUTCHours()).toBe(env.AUTOMATION_SCHEDULE_HOUR_UTC);
    expect(outcome).toMatchObject({
      state: 'STOPPED',
      stopReason: 'DAILY_BUDGET_REACHED',
      errorMessage:
        'This run stopped at the daily Gemini budget. Everything filed so far is saved and the rest continues on the next run.',
    });
  });

  // The morning question is "what happened overnight", and it is answered from this row alone.
  it('ends every run with counters and a reason a person can read', async () => {
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await service.runScheduledAccount('account-1', 'user-1');

    expect(outcome?.counts).toMatchObject({
      messagesSeen: 1,
      aiClassified: 1,
      messagesLabeled: 1,
      backlogRemaining: 0,
      providerCalls: 1,
    });
    expect(outcome?.featureRunId).toBe('run-1');
  });

  // Overnight the only thing that can explain a crash is the run record, so the failure has to
  // reach it rather than escaping the tick as an unhandled rejection.
  it('lets a hard failure reach the run record instead of the tick', async () => {
    mocks.incrementalSync.mockRejectedValue(new Error('gmail unreachable'));
    mocks.initialSync.mockRejectedValue(new Error('gmail unreachable'));
    mocks.activityRunToCompletion.mockImplementation(
      async (_runId: string, work: (report: unknown) => Promise<RunOutcome>) => {
        await expect(work(async () => undefined)).rejects.toThrow();
      },
    );
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await expect(service.runScheduledAccount('account-1', 'user-1')).resolves.toMatchObject({
      success: true,
    });
    // The run is closed as FAILED and the lease released, so the next tick is not locked out.
    expect(mocks.transactionRunUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });

  // "Picks up mail that arrived since the last run" is a two-step claim, and the first step is
  // the one a mocked suite can quietly skip: a run that reads the database without refreshing it
  // first would file yesterday's mail every night and look perfectly healthy doing it.
  it('refreshes the mailbox before it reads it, not after', async () => {
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await service.runScheduledAccount('account-1', 'user-1');

    expect(mocks.incrementalSync).toHaveBeenCalledWith('user-1');
    expect(mocks.incrementalSync.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.messageFindMany.mock.invocationCallOrder[0]!,
    );
  });

  // Gmail expires a history id after about a week. An unattended scheduler that treated that as
  // a failure would stop filing on the first quiet week and never start again on its own.
  it('falls back to a full sync when the Gmail history id has expired', async () => {
    mocks.incrementalSync.mockRejectedValue(
      new AppError('GMAIL_HISTORY_EXPIRED', 'History id expired.', 409),
    );
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await service.runScheduledAccount('account-1', 'user-1');

    expect(mocks.initialSync).toHaveBeenCalledWith('user-1');
    expect(outcome).toMatchObject({ state: 'SUCCEEDED' });
  });

  // Every message is checkpointed by its action row, so a run interrupted mid-flight resumes
  // where it stopped rather than re-classifying and re-billing what it already filed.
  it('only ever looks at mail that has no action row yet', async () => {
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await service.runScheduledAccount('account-1', 'user-1');

    const call = mocks.messageFindMany.mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({
      connected_google_account_id: 'account-1',
      automationAction: null,
      deleted_at: null,
    });
    // Newest first: the tree was designed from recent mail, so that is where a run pays off.
    expect(call?.orderBy).toEqual({ internal_date: 'desc' });
  });

  /**
   * The two halves of "resumes on the next tick" were each proven separately — the run writes a
   * `retry_at`, and the eligibility query selects on `retry_at <= now` — which leaves the join
   * between them assumed. If a run wrote a backoff no tick ever matched, both halves would still
   * pass and filing would stop dead. This closes it: take the timestamp a rate-limited run
   * actually wrote, then ask the scheduler, at that moment, whether it would come back for it.
   */
  it('writes a backoff that a later tick actually selects on', async () => {
    mocks.classifier.mockRejectedValue(
      new GeminiProviderError(
        'PROVIDER_RATE_LIMITED',
        'Gemini is rate limited.',
        503,
        429,
        'RESOURCE_EXHAUSTED',
        'request-safe-id',
        false,
      ),
    );
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());
    await service.runScheduledAccount('account-1', 'user-1');
    const retryAt = releasedState()['retry_at'] as Date;

    mocks.accountFindMany.mockResolvedValue([]);
    vi.useFakeTimers();
    try {
      // One tick before the backoff elapses: the account is still being left alone.
      vi.setSystemTime(new Date(retryAt.getTime() - 60_000));
      await service.eligibleScheduledAccounts();
      const tooEarly = mocks.accountFindMany.mock.calls.at(-1)![0].where.AND[1].OR[2];
      expect(tooEarly.automation_state.is.retry_at.lte.getTime()).toBeLessThan(retryAt.getTime());

      // The first tick after it: the bound has moved past the stamp, so the row comes back.
      vi.setSystemTime(new Date(retryAt.getTime() + 1));
      await service.eligibleScheduledAccounts();
      const dueNow = mocks.accountFindMany.mock.calls.at(-1)![0].where.AND[1].OR[2];
      expect(dueNow.automation_state.is.retry_at.lte.getTime()).toBeGreaterThan(retryAt.getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to file at all while automation is disabled', async () => {
    env.AUTOMATION_ENABLED = false;
    mocks.activityRunToCompletion.mockImplementation(
      async (_runId: string, work: (report: unknown) => Promise<RunOutcome>) => {
        await expect(work(async () => undefined)).rejects.toMatchObject({
          code: 'AUTOMATION_DISABLED',
        });
      },
    );
    const service = new AutomationService({ classify: mocks.classifier }, gmailStub());

    await service.runScheduledAccount('account-1', 'user-1');

    expect(mocks.classifier).not.toHaveBeenCalled();
    expect(mocks.runCreate).not.toHaveBeenCalled();
  });
});
