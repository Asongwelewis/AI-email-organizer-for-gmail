import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runFindFirst: vi.fn(),
  runFindMany: vi.fn(),
  runCreate: vi.fn(),
  runUpdateMany: vi.fn(),
  accountFindFirst: vi.fn(),
}));

vi.mock('../src/database/prisma.js', () => ({
  prisma: {
    activity_runs: {
      findFirst: mocks.runFindFirst,
      findMany: mocks.runFindMany,
      create: mocks.runCreate,
      updateMany: mocks.runUpdateMany,
    },
    connected_google_accounts: { findFirst: mocks.accountFindFirst },
  },
}));

import {
  ActivityRepository,
  RUN_EXPIRY_SECONDS,
} from '../src/features/activity/activity.repository.js';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const RUN = '33333333-3333-4333-8333-333333333333';

const repository = new ActivityRepository();

/** Seconds from now to a Date the repository stamped. */
const secondsOut = (value: Date) => (value.getTime() - Date.now()) / 1000;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runUpdateMany.mockResolvedValue({ count: 0 });
  mocks.runCreate.mockResolvedValue({ id: RUN });
  mocks.runFindFirst.mockResolvedValue(null);
  mocks.runFindMany.mockResolvedValue([]);
});

/**
 * The service above this is well covered with the repository mocked out, which left the mechanism
 * that actually keeps the one-live-run slot honest — the expiry stamp, the heartbeat that pushes
 * it out, and the reclamation that frees a slot a dead process is still holding — with no test at
 * all. A wedged slot is silent: every later run reports "already running" forever and nothing is
 * ever written to say why.
 */
describe('reclaiming a run whose process stopped reporting', () => {
  it('fails only expired RUNNING runs of the one kind, on the one account', async () => {
    await repository.reclaimAbandoned(ACCOUNT, 'AUTOMATION_FILING');

    const { where } = mocks.runUpdateMany.mock.calls[0]![0];
    expect(where.connected_google_account_id).toBe(ACCOUNT);
    expect(where.kind).toBe('AUTOMATION_FILING');
    // A finished run is already accounted for; reclaiming it would rewrite its ending.
    expect(where.state).toBe('RUNNING');
    // And a run still reporting is alive, however long it has been going.
    expect(secondsOut(where.expires_at.lt)).toBeCloseTo(0, 0);
  });

  it('leaves a readable ending rather than a run that just stops', async () => {
    await repository.reclaimAbandoned(ACCOUNT, 'GMAIL_INITIAL_SYNC');

    const { data } = mocks.runUpdateMany.mock.calls[0]![0];
    expect(data).toMatchObject({ state: 'FAILED', error_code: 'RUN_ABANDONED' });
    expect(data.finished_at).toBeInstanceOf(Date);
    // The lease and the checkpoints mean nothing was lost, and the message has to say so — this
    // is the only thing a person sees after a deploy killed a run overnight.
    expect(data.error_message).toMatch(/no work was lost/i);
    expect(data.error_message).toMatch(/run it again/i);
  });

  it('reports how many it reclaimed', async () => {
    mocks.runUpdateMany.mockResolvedValue({ count: 2 });

    await expect(repository.reclaimAbandoned(ACCOUNT, 'AUTOMATION_FILING')).resolves.toBe(2);
  });
});

describe('the heartbeat', () => {
  it('stamps an expiry on a new run, so an unreported run is reclaimable', async () => {
    await repository.create({ accountId: ACCOUNT, kind: 'AUTOMATION_FILING', trigger: 'MANUAL' });

    const { data } = mocks.runCreate.mock.calls[0]![0];
    expect(secondsOut(data.expires_at)).toBeGreaterThan(RUN_EXPIRY_SECONDS - 5);
    expect(secondsOut(data.expires_at)).toBeLessThanOrEqual(RUN_EXPIRY_SECONDS);
  });

  // Reporting progress IS the heartbeat: a backfill runs far longer than one expiry window, and
  // only the progress it reports keeps the next start from reclaiming it out from under itself.
  it('pushes the expiry out every time progress is reported', async () => {
    await repository.reportProgress(RUN, { processed: 40, total: 250 });

    const { where, data } = mocks.runUpdateMany.mock.calls[0]![0];
    expect(where).toEqual({ id: RUN, state: 'RUNNING' });
    expect(secondsOut(data.expires_at)).toBeGreaterThan(RUN_EXPIRY_SECONDS - 5);
    expect(data.processed_count).toBe(40);
    expect(data.total_count).toBe(250);
  });

  // A reclaimed run must not be resurrected by work that is still limping along behind it.
  it('cannot revive a run that is no longer RUNNING', async () => {
    await repository.reportProgress(RUN, { processed: 1 });
    await repository.attachFeatureRun(RUN, 'feature-run-1');
    await repository.finish(RUN, { state: 'SUCCEEDED' });

    for (const [query] of mocks.runUpdateMany.mock.calls) {
      expect(query.where).toMatchObject({ id: RUN, state: 'RUNNING' });
    }
  });

  it('leaves a count alone when the caller did not report one', async () => {
    await repository.reportProgress(RUN, { processed: 40 });

    const { data } = mocks.runUpdateMany.mock.calls[0]![0];
    expect(data).not.toHaveProperty('total_count');
    expect(data).not.toHaveProperty('counts');
  });
});

describe('finishing a run', () => {
  it('records a stop reason and clears nothing it was not given', async () => {
    await repository.finish(RUN, {
      state: 'STOPPED',
      stopReason: 'DAILY_BUDGET_REACHED',
      errorMessage: 'This run stopped at the daily Gemini budget.',
    });

    const { data } = mocks.runUpdateMany.mock.calls[0]![0];
    expect(data).toMatchObject({
      state: 'STOPPED',
      stop_reason: 'DAILY_BUDGET_REACHED',
      error_code: null,
    });
    expect(data.finished_at).toBeInstanceOf(Date);
    // No progress was passed, so whatever the run last reported still stands.
    expect(data).not.toHaveProperty('processed_count');
  });

  // An ending is not a heartbeat: a finished run must not become reclaimable-looking again, and
  // must not have its expiry pushed out either.
  it('does not touch the expiry when a run ends', async () => {
    await repository.finish(RUN, { state: 'SUCCEEDED', processedCount: 250 });

    expect(mocks.runUpdateMany.mock.calls[0]![0].data).not.toHaveProperty('expires_at');
  });
});

describe('reading runs back', () => {
  it('returns an account`s runs newest first, bounded by the caller`s limit', async () => {
    await repository.recent(ACCOUNT, 20);

    expect(mocks.runFindMany).toHaveBeenCalledWith({
      where: { connected_google_account_id: ACCOUNT },
      orderBy: { started_at: 'desc' },
      take: 20,
    });
  });

  // A run id is not a capability: it only resolves inside the account that owns it.
  it('scopes a single run to the account asking for it', async () => {
    await repository.runForAccount(ACCOUNT, RUN);

    expect(mocks.runFindFirst).toHaveBeenCalledWith({
      where: { id: RUN, connected_google_account_id: ACCOUNT },
    });
  });

  it('refuses to resolve an account for a user with no connected mailbox', async () => {
    mocks.accountFindFirst.mockResolvedValue(null);

    await expect(repository.activeAccountForUser('user-1')).rejects.toMatchObject({
      code: 'GMAIL_ACCOUNT_NOT_CONNECTED',
      statusCode: 409,
    });
  });
});
