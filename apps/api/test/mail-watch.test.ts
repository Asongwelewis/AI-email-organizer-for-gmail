import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  activityCount: vi.fn(),
  messageCount: vi.fn(),
  runUpsert: vi.fn(),
  accountFindMany: vi.fn(),
}));

vi.mock('../src/database/prisma.js', () => ({
  prisma: {
    activity_runs: { count: mocks.activityCount },
    gmail_message_metadata: { count: mocks.messageCount },
    automation_runs: { upsert: mocks.runUpsert },
    connected_google_accounts: { findMany: mocks.accountFindMany },
  },
}));
vi.mock('../src/integrations/gmail/gmail.service.js', () => ({ gmailSyncService: {} }));
vi.mock('../src/features/automation/facet-classification.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/features/automation/facet-classification.service.js')
  >('../src/features/automation/facet-classification.service.js');
  return { ...actual, facetClassificationService: {} };
});

import { env } from '../src/config/env.js';
import { AppError } from '../src/errors/AppError.js';
import { MailWatchService } from '../src/features/automation/mail-watch.service.js';

const counters = (overrides: Record<string, unknown> = {}) => ({
  messagesSeen: 3,
  ruleDecided: 2,
  modelDecided: 0,
  domainAssigned: 2,
  intentAssigned: 2,
  entityAssigned: 2,
  crossEntityRuleHits: 0,
  rulesLearned: 0,
  deferred: 1,
  failed: 0,
  providerCalls: 0,
  usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
  costMicrousd: 0,
  stoppedReason: null,
  lastErrorCode: null,
  ...overrides,
});

const NOW = new Date('2026-10-18T12:00:00.000Z').getTime();

function setup() {
  const gmail = { hasNewHistory: vi.fn(), incrementalSync: vi.fn() };
  const classification = { classifyAccount: vi.fn() };
  const notifier = { recordNewMail: vi.fn().mockResolvedValue(0) };
  const service = new MailWatchService(gmail as never, classification as never, notifier);
  return { gmail, classification, notifier, service };
}

const stored = (minutesAgo: number) =>
  ({ created_at: new Date(NOW - minutesAgo * 60_000) }) as never;

/**
 * The watcher runs every minute for as long as the server is up, so what matters most is what it
 * does NOT do: nothing at all when the mailbox is unchanged, nothing to the backlog, and no flood
 * of errors from one broken account.
 */
describe('checking a mailbox for new mail', () => {
  const originalKey = env.GEMINI_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    env.GEMINI_API_KEY = 'test-gemini-key';
    mocks.activityCount.mockResolvedValue(0);
    mocks.messageCount.mockResolvedValue(0);
    mocks.runUpsert.mockResolvedValue({});
  });

  afterAll(() => {
    env.GEMINI_API_KEY = originalKey;
  });

  it('does nothing beyond the one question when the mailbox has not changed', async () => {
    const { gmail, classification, service } = setup();
    gmail.hasNewHistory.mockResolvedValue(false);

    const result = await service.check('account-1', 'user-1', NOW);

    expect(result.outcome).toBe('UNCHANGED');
    expect(gmail.incrementalSync).not.toHaveBeenCalled();
    expect(classification.classifyAccount).not.toHaveBeenCalled();
    expect(mocks.runUpsert).not.toHaveBeenCalled();
    expect(service.lastCheckedAt('account-1')?.getTime()).toBe(NOW);
  });

  it('syncs new mail and sorts only new mail, behind the batching gate', async () => {
    const { gmail, classification, service } = setup();
    gmail.hasNewHistory.mockResolvedValue(true);
    gmail.incrementalSync.mockResolvedValue({ messagesUpserted: 3 });
    classification.classifyAccount.mockResolvedValue(counters());

    const result = await service.check('account-1', 'user-1', NOW);

    expect(result).toMatchObject({ outcome: 'CHECKED', synced: 3, sorted: 2, deferred: 1 });
    expect(classification.classifyAccount).toHaveBeenCalledWith(
      'account-1',
      expect.objectContaining({ scope: 'new', modelGate: expect.any(Function) }),
    );
  });

  it('sorts mail that was left waiting even when nothing new has arrived', async () => {
    const { gmail, classification, service } = setup();
    gmail.hasNewHistory.mockResolvedValue(false);
    mocks.messageCount.mockResolvedValue(2);
    classification.classifyAccount.mockResolvedValue(counters({ ruleDecided: 0, modelDecided: 2 }));

    const result = await service.check('account-1', 'user-1', NOW);

    expect(result.outcome).toBe('CHECKED');
    expect(gmail.incrementalSync).not.toHaveBeenCalled();
    expect(classification.classifyAccount).toHaveBeenCalledOnce();
  });

  it('announces new mail after every check', async () => {
    const { gmail, notifier, service } = setup();
    gmail.hasNewHistory.mockResolvedValue(false);
    notifier.recordNewMail.mockResolvedValue(2);

    const result = await service.check('account-1', 'user-1', NOW);

    expect(notifier.recordNewMail).toHaveBeenCalledWith('account-1', NOW);
    expect(result).toEqual({ outcome: 'UNCHANGED', announced: 2 });
  });

  // Mail sorted and not announced is better than mail not sorted.
  it('keeps sorting when announcing fails', async () => {
    const { gmail, notifier, service } = setup();
    gmail.hasNewHistory.mockResolvedValue(false);
    notifier.recordNewMail.mockRejectedValue(new Error('push service down'));

    await expect(service.check('account-1', 'user-1', NOW)).resolves.toEqual({
      outcome: 'UNCHANGED',
    });
  });

  it('stands aside while a full run is working on the same mailbox', async () => {
    const { gmail, service } = setup();
    mocks.activityCount.mockResolvedValue(1);

    const result = await service.check('account-1', 'user-1', NOW);

    expect(result).toEqual({ outcome: 'SKIPPED', reason: 'FULL_RUN_IN_PROGRESS' });
    expect(gmail.hasNewHistory).not.toHaveBeenCalled();
  });

  // Whether a model is used is the classifier's decision, made per mailbox. The watcher sorts
  // new mail either way; without a key that means by rules.
  it('still sorts new mail without a Gemini key', async () => {
    env.GEMINI_API_KEY = undefined;
    const { gmail, classification, service } = setup();
    gmail.hasNewHistory.mockResolvedValue(true);
    gmail.incrementalSync.mockResolvedValue({ messagesUpserted: 1 });
    classification.classifyAccount.mockResolvedValue(counters({ ruleDecided: 1 }));

    const result = await service.check('account-1', 'user-1', NOW);

    expect(result.outcome).toBe('CHECKED');
    expect(classification.classifyAccount).toHaveBeenCalledWith(
      'account-1',
      expect.objectContaining({ scope: 'new' }),
    );
  });

  it.each([
    'GMAIL_SYNC_ALREADY_RUNNING',
    'AUTOMATION_ALREADY_RUNNING',
    'FACET_VOCABULARY_NOT_APPROVED',
  ] as const)('treats %s as "not this time" rather than a failure', async (code) => {
    const { gmail, service } = setup();
    gmail.hasNewHistory.mockRejectedValue(new AppError(code, 'busy', 409));

    await expect(service.check('account-1', 'user-1', NOW)).resolves.toEqual({
      outcome: 'SKIPPED',
      reason: code,
    });
    // And it is asked again on the very next tick.
    gmail.hasNewHistory.mockResolvedValue(false);
    await expect(service.check('account-1', 'user-1', NOW + 60_000)).resolves.toMatchObject({
      outcome: 'UNCHANGED',
    });
  });

  it('backs a failing mailbox off, doubling, instead of failing every minute', async () => {
    const { gmail, service } = setup();
    gmail.hasNewHistory.mockRejectedValue(new Error('token revoked'));

    await expect(service.check('account-1', 'user-1', NOW)).rejects.toThrow('token revoked');
    // Inside the first minute of backoff the mailbox is not asked at all.
    await expect(service.check('account-1', 'user-1', NOW + 30_000)).resolves.toEqual({
      outcome: 'BACKING_OFF',
    });
    expect(gmail.hasNewHistory).toHaveBeenCalledTimes(1);

    await expect(service.check('account-1', 'user-1', NOW + 61_000)).rejects.toThrow();
    // Second failure: two minutes.
    await expect(service.check('account-1', 'user-1', NOW + 61_000 + 90_000)).resolves.toEqual({
      outcome: 'BACKING_OFF',
    });

    gmail.hasNewHistory.mockResolvedValue(false);
    await expect(
      service.check('account-1', 'user-1', NOW + 61_000 + 121_000),
    ).resolves.toMatchObject({ outcome: 'UNCHANGED' });
  });

  /*
   * One row per account per day, not per check. It has to exist, because the daily token caps are
   * a sum over today's rows, and it must not become 1,440 rows a day.
   */
  it('adds what it sorted to one row for the day', async () => {
    const { gmail, classification, service } = setup();
    gmail.hasNewHistory.mockResolvedValue(true);
    gmail.incrementalSync.mockResolvedValue({ messagesUpserted: 12 });
    classification.classifyAccount.mockResolvedValue(
      counters({
        ruleDecided: 2,
        modelDecided: 10,
        providerCalls: 1,
        usage: { inputTokens: 900, cachedInputTokens: 0, outputTokens: 400 },
        costMicrousd: 1300,
      }),
    );

    await service.check('account-1', 'user-1', NOW);

    const call = mocks.runUpsert.mock.calls[0]?.[0] as {
      where: { idempotency_key: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(call.where.idempotency_key).toMatch(/^account-1:watch:\d{4}-\d{2}-\d{2}$/);
    expect(call.create).toMatchObject({
      trigger: 'SCHEDULED',
      status: 'COMPLETED',
      ai_classified_count: 10,
      pattern_reused_count: 2,
      input_tokens: 900,
    });
    expect(call.update['input_tokens']).toEqual({ increment: 900 });
    // The table refuses a row that completed before it started. Left to its default, started_at
    // is the database's now(), a few milliseconds after this process's — found against real
    // Postgres, which no mock could have shown.
    expect(call.create['started_at']).toEqual(call.create['completed_at']);
    expect(call.update['ai_classified_count']).toEqual({ increment: 10 });
  });

  it('writes no row for a check that sorted nothing and spent nothing', async () => {
    const { gmail, classification, service } = setup();
    gmail.hasNewHistory.mockResolvedValue(true);
    gmail.incrementalSync.mockResolvedValue({ messagesUpserted: 0 });
    classification.classifyAccount.mockResolvedValue(
      counters({ ruleDecided: 0, modelDecided: 0, deferred: 0 }),
    );

    await service.check('account-1', 'user-1', NOW);

    expect(mocks.runUpsert).not.toHaveBeenCalled();
  });
});

describe('when queued mail is worth a Gemini call', () => {
  it('waits while the queue is small and young', () => {
    const { service } = setup();
    expect(service.worthACall([stored(1), stored(2)], NOW)).toBe(false);
  });

  it('calls once a batch has queued', () => {
    const { service } = setup();
    const batch = Array.from({ length: env.AUTOMATION_CLASSIFY_BATCH_THRESHOLD }, () => stored(0));
    expect(service.worthACall(batch, NOW)).toBe(true);
  });

  it('calls for a single message once it has waited long enough', () => {
    const { service } = setup();
    expect(service.worthACall([stored(env.AUTOMATION_CLASSIFY_MAX_WAIT_MINUTES)], NOW)).toBe(true);
  });
});
