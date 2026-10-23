import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  accountUpdate: vi.fn(),
  accountFindMany: vi.fn(),
  runFindFirst: vi.fn(),
  messageCount: vi.fn(),
  syncState: vi.fn(),
  audit: vi.fn(),
  recordUsage: vi.fn(),
}));

vi.mock('../src/config/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  safeErrorDetails: () => ({}),
}));
vi.mock('../src/database/prisma.js', () => ({
  prisma: {
    connected_google_accounts: { update: mocks.accountUpdate, findMany: mocks.accountFindMany },
    activity_runs: { findFirst: mocks.runFindFirst },
    gmail_message_metadata: { count: mocks.messageCount },
  },
}));
vi.mock('../src/integrations/gmail/gmail.repository.js', () => ({
  gmailRepository: { state: mocks.syncState },
}));
vi.mock('../src/audit/audit.service.js', () => ({ auditService: { record: mocks.audit } }));
vi.mock('../src/features/automation/usage-ledger.js', () => ({
  recordDailyUsage: mocks.recordUsage,
}));

const { env } = await import('../src/config/env.js');
const { AppError } = await import('../src/errors/AppError.js');
const { APPROVED_FACET_VOCABULARY } = await import('../src/features/label-discovery/facets.js');
const { OnboardingService } = await import('../src/features/onboarding/onboarding.service.js');

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: ACCOUNT_ID,
    user_id: USER_ID,
    onboarding_stage: null,
    onboarding_completed_at: null,
    ...overrides,
  };
}

function counters(overrides: Record<string, unknown> = {}) {
  return {
    messagesSeen: 0,
    ruleDecided: 0,
    modelDecided: 0,
    domainAssigned: 0,
    intentAssigned: 0,
    entityAssigned: 0,
    crossEntityRuleHits: 0,
    rulesLearned: 0,
    deferred: 0,
    failed: 0,
    providerCalls: 0,
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    costMicrousd: 0,
    stoppedReason: null,
    lastErrorCode: null,
    ...overrides,
  };
}

const empty = { domain: [], intent: [] };

/**
 * Drives one onboarding the way the activity service would, and hands back how it ended. The work
 * runs detached in production; here it is awaited so each stage can be asserted.
 */
const OWNER = { owner: true, mode: 'MODEL' as const, windowStart: null };
const BETA_WINDOW = new Date('2024-10-21T00:00:00.000Z');
const BETA = { owner: false, mode: 'RULES' as const, windowStart: BETA_WINDOW };

function harness(
  options: {
    account?: ReturnType<typeof account>;
    policy?: typeof OWNER | typeof BETA;
  } = {},
) {
  const outcomes: Array<Promise<unknown>> = [];
  const progress: unknown[] = [];
  const activity = {
    start: vi.fn().mockResolvedValue({
      runId: 'run-1',
      state: 'RUNNING',
      kind: 'ONBOARDING',
      startedAt: new Date().toISOString(),
      alreadyRunning: false,
    }),
    runDetached: vi.fn((_runId: string, work: (report: unknown) => Promise<unknown>) => {
      outcomes.push(
        work(async (entry: unknown) => {
          progress.push(entry);
        }),
      );
    }),
  };
  const accounts = {
    activeAccountForUser: vi.fn().mockResolvedValue(options.account ?? account()),
  };
  const classification = { classifyAccount: vi.fn() };
  const vocabularies = {
    approved: vi.fn().mockResolvedValue(empty),
    approve: vi.fn().mockResolvedValue(APPROVED_FACET_VOCABULARY),
  };
  const gmail = { initialSync: vi.fn().mockResolvedValue({}) };
  const service = new OnboardingService(
    activity as never,
    accounts as never,
    classification as never,
    vocabularies as never,
    gmail as never,
    { forAccount: async () => options.policy ?? OWNER },
  );
  return { service, activity, accounts, classification, vocabularies, gmail, outcomes, progress };
}

beforeEach(() => {
  vi.clearAllMocks();
  env.GEMINI_API_KEY = 'test-gemini-key';
  env.ONBOARDING_SORT_LIMIT = 300;
  env.ONBOARDING_CONCURRENCY = 3;
  mocks.syncState.mockResolvedValue(null);
  mocks.messageCount.mockResolvedValue(500);
  mocks.accountUpdate.mockResolvedValue({});
  mocks.recordUsage.mockResolvedValue(undefined);
});

describe('onboarding a new mailbox', () => {
  it('reads the mail, approves the starter categories, sorts the newest mail and hands over', async () => {
    const run = harness();
    run.classification.classifyAccount
      .mockResolvedValueOnce(counters({ modelDecided: 100, providerCalls: 4 }))
      .mockResolvedValueOnce(counters({ modelDecided: 100, providerCalls: 4 }))
      .mockResolvedValueOnce(counters({ ruleDecided: 40, modelDecided: 60, providerCalls: 3 }));

    await run.service.begin(USER_ID);
    const outcome = await run.outcomes[0];

    expect(run.gmail.initialSync).toHaveBeenCalledWith(USER_ID, expect.any(Function));
    // The step that used to wait on a screen that did not exist: approved on the person's behalf,
    // with the whole starter set, and recorded as automatic.
    const approved = run.vocabularies.approve.mock.calls[0]![1] as Array<{ facet: string }>;
    expect(approved.filter((value) => value.facet === 'domain')).toHaveLength(
      APPROVED_FACET_VOCABULARY.domain.length,
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ automatic: true }) }),
    );
    // Sorted in passes against the onboarding share of the key, newest first, until the limit.
    expect(run.classification.classifyAccount).toHaveBeenCalledTimes(3);
    expect(run.classification.classifyAccount).toHaveBeenCalledWith(
      ACCOUNT_ID,
      expect.objectContaining({ scope: 'backlog', priority: 'onboarding', limit: 100 }),
    );
    expect(mocks.recordUsage).toHaveBeenCalledTimes(3);
    expect(mocks.accountUpdate).toHaveBeenLastCalledWith({
      where: { id: ACCOUNT_ID },
      data: { onboarding_stage: 'DONE', onboarding_completed_at: expect.any(Date) },
    });
    expect(outcome).toMatchObject({ state: 'SUCCEEDED', processed: 300, total: 300 });
  });

  it('names each stage on the account as it reaches it', async () => {
    const run = harness();
    run.classification.classifyAccount.mockResolvedValue(counters({ modelDecided: 300 }));

    await run.service.begin(USER_ID);
    await run.outcomes[0];

    const stages = mocks.accountUpdate.mock.calls.map(
      ([input]) => (input as { data: { onboarding_stage: string } }).data.onboarding_stage,
    );
    expect(stages).toEqual(['SYNCING', 'LEARNING', 'SORTING', 'DONE']);
  });

  it('skips what is already done, and never replaces categories a person chose', async () => {
    const run = harness();
    mocks.syncState.mockResolvedValue({ initial_sync_completed_at: new Date() });
    run.vocabularies.approved.mockResolvedValue(APPROVED_FACET_VOCABULARY);
    run.classification.classifyAccount.mockResolvedValue(counters({ modelDecided: 300 }));

    await run.service.begin(USER_ID);
    await run.outcomes[0];

    expect(run.gmail.initialSync).not.toHaveBeenCalled();
    expect(run.vocabularies.approve).not.toHaveBeenCalled();
  });

  // Rules cost nothing but database time, so a beta mailbox is sorted to the end of its window
  // before setup says done: nothing it holds is left unsorted, and nothing older is counted.
  it('sorts every message in a beta mailbox`s window, and only inside it', async () => {
    const run = harness({ policy: BETA });
    mocks.messageCount.mockResolvedValue(2500);
    run.classification.classifyAccount
      .mockResolvedValueOnce(counters({ ruleDecided: 2000 }))
      .mockResolvedValueOnce(counters({ ruleDecided: 500 }));

    await run.service.begin(USER_ID);
    const outcome = await run.outcomes[0];

    expect(mocks.messageCount.mock.calls[0]![0].where.internal_date).toEqual({ gte: BETA_WINDOW });
    expect(run.classification.classifyAccount).toHaveBeenNthCalledWith(
      1,
      ACCOUNT_ID,
      expect.objectContaining({ limit: 2000 }),
    );
    expect(run.classification.classifyAccount).toHaveBeenNthCalledWith(
      2,
      ACCOUNT_ID,
      expect.objectContaining({ limit: 500 }),
    );
    expect(outcome).toMatchObject({ state: 'SUCCEEDED', processed: 2500, total: 2500 });
  });

  // No key no longer means waiting: without one, every mailbox is sorted by rules.
  it('finishes without a Gemini key', async () => {
    const run = harness({ policy: { ...OWNER, mode: 'RULES' as const } as never });
    env.GEMINI_API_KEY = undefined;
    mocks.messageCount.mockResolvedValue(40);
    run.classification.classifyAccount.mockResolvedValue(counters({ ruleDecided: 40 }));

    await run.service.begin(USER_ID);

    await expect(run.outcomes[0]).resolves.toMatchObject({ state: 'SUCCEEDED', processed: 40 });
  });

  it('stays pending when the shared budget stopped it before anything was sorted', async () => {
    const run = harness();
    run.classification.classifyAccount.mockResolvedValue(
      counters({ stoppedReason: 'SHARED_DAILY_LIMIT_REACHED' }),
    );

    await run.service.begin(USER_ID);

    await expect(run.outcomes[0]).resolves.toMatchObject({
      state: 'STOPPED',
      stopReason: 'SHARED_DAILY_LIMIT_REACHED',
    });
  });

  // Some folders are enough to open the inbox on; the full runs finish the backlog.
  it('hands over once something is sorted, even when the budget ran out part way', async () => {
    const run = harness();
    run.classification.classifyAccount.mockResolvedValue(
      counters({ modelDecided: 80, stoppedReason: 'PROVIDER_RATE_LIMITED' }),
    );

    await run.service.begin(USER_ID);

    await expect(run.outcomes[0]).resolves.toMatchObject({ state: 'SUCCEEDED', processed: 80 });
  });

  it('stops and comes back later when another sync holds the mailbox', async () => {
    const run = harness();
    run.gmail.initialSync.mockRejectedValue(
      new AppError('GMAIL_SYNC_ALREADY_RUNNING', 'busy', 409),
    );

    await run.service.begin(USER_ID);

    await expect(run.outcomes[0]).resolves.toMatchObject({
      state: 'STOPPED',
      stopReason: 'WAITING_FOR_SYNC',
    });
  });

  // A grant problem is answered by the person reconnecting; retrying every five minutes would only
  // fail the same way and report it to Sentry each time.
  it('asks for a reconnect when Gmail refuses permission', async () => {
    const run = harness();
    run.gmail.initialSync.mockRejectedValue(
      new AppError('GMAIL_PERMISSION_DENIED', 'Gmail permission is insufficient.', 403),
    );

    await run.service.begin(USER_ID);

    await expect(run.outcomes[0]).resolves.toMatchObject({
      state: 'STOPPED',
      stopReason: 'GMAIL_PERMISSION_DENIED',
    });
  });

  it('does nothing for a mailbox that has finished', async () => {
    const run = harness({ account: account({ onboarding_completed_at: new Date() }) });

    await expect(run.service.begin(USER_ID)).resolves.toBeNull();
    expect(run.activity.start).not.toHaveBeenCalled();
  });

  it('joins a run already in flight instead of starting a second one', async () => {
    const run = harness();
    run.activity.start.mockResolvedValue({
      runId: 'run-1',
      state: 'RUNNING',
      kind: 'ONBOARDING',
      startedAt: new Date().toISOString(),
      alreadyRunning: true,
    });

    await run.service.begin(USER_ID);

    expect(run.activity.runDetached).not.toHaveBeenCalled();
  });

  /*
   * The key is shared, so a burst of sign-ups queues for a few slots instead of every progress bar
   * crawling through one request queue together.
   */
  it('runs no more mailboxes at once than it has slots for', async () => {
    env.ONBOARDING_CONCURRENCY = 1;
    const run = harness();
    let finishFirst: () => void = () => undefined;
    run.gmail.initialSync
      .mockImplementationOnce(() => new Promise<void>((resolve) => (finishFirst = resolve)))
      .mockResolvedValue({});
    run.classification.classifyAccount.mockResolvedValue(counters({ modelDecided: 300 }));

    await run.service.begin(USER_ID);
    await run.service.begin(USER_ID);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(run.gmail.initialSync).toHaveBeenCalledTimes(1);

    finishFirst();
    await Promise.all(run.outcomes);
    expect(run.gmail.initialSync).toHaveBeenCalledTimes(2);
  });
});

describe('what a person is told', () => {
  it('explains a stop in plain words and never names the server setting', async () => {
    const run = harness();
    mocks.runFindFirst.mockResolvedValue({
      id: 'run-1',
      state: 'STOPPED',
      stop_reason: 'SORTING_NOT_CONFIGURED',
      error_code: null,
      processed_count: 0,
      total_count: null,
      counts: {},
      started_at: new Date(),
      finished_at: new Date(),
    });

    const status = await run.service.status(USER_ID);

    expect(status.state).toBe('STOPPED');
    expect(status.message).toMatch(/start on its own/);
    expect(status.message).not.toMatch(/GEMINI|key/i);
  });

  it('is pending before anything has started, and done once finished', async () => {
    const pending = harness();
    mocks.runFindFirst.mockResolvedValue(null);
    await expect(pending.service.status(USER_ID)).resolves.toMatchObject({ state: 'PENDING' });

    const done = harness({
      account: account({ onboarding_stage: 'DONE', onboarding_completed_at: new Date() }),
    });
    await expect(done.service.status(USER_ID)).resolves.toMatchObject({
      state: 'DONE',
      stage: 'DONE',
    });
  });
});

describe('the sweep', () => {
  it('starts every pending mailbox it has room for, and never one that is running or just stopped', async () => {
    const run = harness();
    mocks.accountFindMany.mockResolvedValue([{ id: ACCOUNT_ID, user_id: USER_ID }]);
    run.classification.classifyAccount.mockResolvedValue(counters({ modelDecided: 300 }));

    await expect(run.service.sweep(new Date('2026-10-20T10:00:00.000Z'))).resolves.toBe(1);

    const query = mocks.accountFindMany.mock.calls[0]![0] as {
      where: { activity_runs: { none: { OR: Array<Record<string, unknown>> } } };
      take: number;
    };
    expect(query.take).toBe(env.ONBOARDING_CONCURRENCY);
    expect(query.where.activity_runs.none.OR).toEqual([
      { state: 'RUNNING', expires_at: { gt: new Date('2026-10-20T10:00:00.000Z') } },
      { finished_at: { gt: new Date('2026-10-20T09:55:00.000Z') } },
    ]);
  });
});
