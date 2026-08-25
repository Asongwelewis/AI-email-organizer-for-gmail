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
    classifyAccount: vi.fn(),
    fileAccount: vi.fn(),
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

const gmailStub = () => ({
  ensureLabel: vi.fn().mockResolvedValue({ id: 'Label_1', created: false }),
  applyLabel: vi.fn().mockResolvedValue(undefined),
  applyExclusiveLabel: vi.fn().mockResolvedValue(undefined),
  renameLabel: vi.fn().mockResolvedValue(undefined),
});

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

  const classified = (overrides: Record<string, unknown> = {}) => ({
    messagesSeen: 10,
    ruleDecided: 4,
    modelDecided: 6,
    domainAssigned: 10,
    intentAssigned: 9,
    entityAssigned: 10,
    crossEntityRuleHits: 1,
    rulesLearned: 0,
    failed: 0,
    providerCalls: 1,
    usage: { inputTokens: 120, cachedInputTokens: 0, outputTokens: 40 },
    costMicrousd: 2000,
    stoppedReason: null,
    lastErrorCode: null,
    ...overrides,
  });

  const filedCounters = (overrides: Record<string, unknown> = {}) => ({
    seen: 10,
    filed: 8,
    none: 1,
    reviewRequired: 1,
    failed: 0,
    fromRules: 4,
    fromModel: 6,
    labelsCreated: 1,
    labelsReused: 2,
    staleLabelsRemoved: 1,
    pivot: { nodes: [], order: ['entity', 'intent'], unfiled: 0, collapsed: 0 },
    ...overrides,
  });

  const service = () =>
    new AutomationService(
      gmailStub() as never,
      { classifyAccount: mocks.classifyAccount } as never,
      { fileAccount: mocks.fileAccount } as never,
    );

  /** The `update` branch of the schedule stamp, which is where backoff is recorded. */
  function stampedSchedule(): Record<string, unknown> {
    const call = mocks.stateUpsert.mock.calls.at(-1)?.[0] as
      { update: Record<string, unknown> } | undefined;
    return call?.update ?? {};
  }

  beforeEach(() => {
    vi.clearAllMocks();
    outcome = undefined;
    env.AUTOMATION_ENABLED = true;
    env.GEMINI_API_KEY = 'test-gemini-key';
    mocks.stateUpsert.mockResolvedValue({});
    mocks.incrementalSync.mockResolvedValue(undefined);
    mocks.initialSync.mockResolvedValue(undefined);
    mocks.classifyAccount.mockResolvedValue(classified());
    mocks.fileAccount.mockResolvedValue(filedCounters());
    mocks.auditRecord.mockResolvedValue(undefined);
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
    await expect(service().runScheduledAccount('account-1', 'user-1')).resolves.toMatchObject({
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

    await expect(service().runScheduledAccount('account-1', 'user-1')).resolves.toMatchObject({
      status: 'RUNNING',
      runId: null,
    });
    expect(mocks.activityRunToCompletion).not.toHaveBeenCalled();
  });

  // The account-scoped lease now lives in the two facet services, and each takes it for the part
  // of the run it owns. A refusal from either has to end the run rather than be swallowed.
  it('ends the run when another instance holds the account lease', async () => {
    mocks.classifyAccount.mockRejectedValue(
      new AppError('AUTOMATION_ALREADY_RUNNING', 'Mail automation is already running.', 409),
    );
    mocks.activityRunToCompletion.mockImplementation(
      async (_runId: string, work: (report: unknown) => Promise<RunOutcome>) => {
        await expect(work(async () => undefined)).rejects.toMatchObject({
          code: 'AUTOMATION_ALREADY_RUNNING',
        });
      },
    );

    await service().runScheduledAccount('account-1', 'user-1');

    expect(mocks.fileAccount).not.toHaveBeenCalled();
  });

  it('schedules the next run at the configured hour and clears the backoff on success', async () => {
    await service().runScheduledAccount('account-1', 'user-1');

    const stamped = stampedSchedule();
    expect(stamped['retry_at']).toBeNull();
    expect(stamped['failure_count']).toBe(0);
    const nextRun = stamped['next_run_at'] as Date;
    expect(nextRun.getUTCHours()).toBe(env.AUTOMATION_SCHEDULE_HOUR_UTC);
    expect(nextRun.getUTCMinutes()).toBe(0);
    expect(nextRun.getTime()).toBeGreaterThan(Date.now());
  });

  // A surviving 429 means the daily request cap, which only resets at midnight Pacific. Retrying
  // every 15 minutes against a spent quota would just log the same failure 96 times.
  it('backs off an hour after a rate limit and leaves the run resumable', async () => {
    mocks.classifyAccount.mockResolvedValue(
      classified({
        stoppedReason: 'PROVIDER_RATE_LIMITED',
        lastErrorCode: 'PROVIDER_RATE_LIMITED',
      }),
    );

    await service().runScheduledAccount('account-1', 'user-1');

    const retryAt = stampedSchedule()['retry_at'] as Date;
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
    mocks.classifyAccount.mockResolvedValue(
      classified({
        stoppedReason: 'PROVIDER_UNUSABLE',
        lastErrorCode: 'PROVIDER_INVALID_RESPONSE',
      }),
    );

    await service().runScheduledAccount('account-1', 'user-1');

    const retryAt = stampedSchedule()['retry_at'] as Date;
    const minutes = (retryAt.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(10);
    expect(minutes).toBeLessThanOrEqual(15);
  });

  // The token budgets are daily and cumulative since 00:00 UTC, so a budget stop has nothing left
  // to spend today. Retrying in 15 minutes would burn a tick to reach the same wall.
  it('waits for the next scheduled hour after the daily budget, not for the next tick', async () => {
    mocks.classifyAccount.mockResolvedValue(classified({ stoppedReason: 'DAILY_BUDGET_REACHED' }));

    await service().runScheduledAccount('account-1', 'user-1');

    const stamped = stampedSchedule();
    expect(stamped['retry_at']).toBeNull();
    expect((stamped['next_run_at'] as Date).getUTCHours()).toBe(env.AUTOMATION_SCHEDULE_HOUR_UTC);
    expect(outcome).toMatchObject({
      state: 'STOPPED',
      stopReason: 'DAILY_BUDGET_REACHED',
      errorMessage:
        'This run stopped at the daily Gemini budget. Everything filed so far is saved and the rest continues on the next run.',
    });
  });

  // The morning question is "what happened overnight", and it is answered from this row alone.
  it('ends every run with counters and a reason a person can read', async () => {
    await service().runScheduledAccount('account-1', 'user-1');

    expect(outcome?.counts).toMatchObject({
      messagesClassified: 10,
      messagesLabeled: 8,
      reviewRequired: 1,
      noLabelSkipped: 1,
      providerCalls: 1,
    });
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

    await expect(service().runScheduledAccount('account-1', 'user-1')).resolves.toMatchObject({
      success: true,
    });
    // The schedule is still stamped, or a crashed run would leave the account never eligible again.
    expect(mocks.stateUpsert).toHaveBeenCalled();
  });

  // "Picks up mail that arrived since the last run" is a two-step claim, and the first step is the
  // one a mocked suite can quietly skip: a run that classified without refreshing first would work
  // through yesterday's mailbox every night and look perfectly healthy doing it.
  it('refreshes the mailbox before it classifies, not after', async () => {
    await service().runScheduledAccount('account-1', 'user-1');

    expect(mocks.incrementalSync).toHaveBeenCalledWith('user-1');
    expect(mocks.incrementalSync.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.classifyAccount.mock.invocationCallOrder[0]!,
    );
  });

  // Gmail expires a history id after about a week. An unattended scheduler that treated that as a
  // failure would stop filing on the first quiet week and never start again on its own.
  it('falls back to a full sync when the Gmail history id has expired', async () => {
    mocks.incrementalSync.mockRejectedValue(
      new AppError('GMAIL_HISTORY_EXPIRED', 'History id expired.', 409),
    );

    await service().runScheduledAccount('account-1', 'user-1');

    expect(mocks.initialSync).toHaveBeenCalledWith('user-1');
    expect(outcome).toMatchObject({ state: 'SUCCEEDED' });
  });

  /**
   * The two halves of "resumes on the next tick" were each proven separately — the run writes a
   * `retry_at`, and the eligibility query selects on `retry_at <= now` — which leaves the join
   * between them assumed. If a run wrote a backoff no tick ever matched, both halves would still
   * pass and filing would stop dead.
   */
  it('writes a backoff that a later tick actually selects on', async () => {
    mocks.classifyAccount.mockResolvedValue(
      classified({
        stoppedReason: 'PROVIDER_RATE_LIMITED',
        lastErrorCode: 'PROVIDER_RATE_LIMITED',
      }),
    );
    const automation = service();
    await automation.runScheduledAccount('account-1', 'user-1');
    const retryAt = stampedSchedule()['retry_at'] as Date;

    mocks.accountFindMany.mockResolvedValue([]);
    vi.useFakeTimers();
    try {
      // One tick before the backoff elapses: the account is still being left alone.
      vi.setSystemTime(new Date(retryAt.getTime() - 60_000));
      await automation.eligibleScheduledAccounts();
      const tooEarly = mocks.accountFindMany.mock.calls.at(-1)![0].where.AND[1].OR[2];
      expect(tooEarly.automation_state.is.retry_at.lte.getTime()).toBeLessThan(retryAt.getTime());

      // The first tick after it: the bound has moved past the stamp, so the row comes back.
      vi.setSystemTime(new Date(retryAt.getTime() + 1));
      await automation.eligibleScheduledAccounts();
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

    await service().runScheduledAccount('account-1', 'user-1');

    expect(mocks.classifyAccount).not.toHaveBeenCalled();
    expect(mocks.fileAccount).not.toHaveBeenCalled();
  });
});
