import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessions: vi.fn(),
  oauthStates: vi.fn(),
  rateLimitHits: vi.fn(),
  notifications: vi.fn(),
  activityRuns: vi.fn(),
  syncRuns: vi.fn(),
  accounts: vi.fn(),
  messages: vi.fn(),
}));

vi.mock('../src/database/prisma.js', () => ({
  prisma: {
    sessions: { deleteMany: mocks.sessions },
    oauth_states: { deleteMany: mocks.oauthStates },
    rate_limit_hits: { deleteMany: mocks.rateLimitHits },
    notifications: { deleteMany: mocks.notifications },
    activity_runs: { deleteMany: mocks.activityRuns },
    gmail_sync_runs: { deleteMany: mocks.syncRuns },
    connected_google_accounts: { findMany: mocks.accounts },
    gmail_message_metadata: { deleteMany: mocks.messages },
  },
}));

const { env } = await import('../src/config/env.js');
const { runHousekeeping } = await import('../src/services/housekeeping.js');

const NOW = new Date('2026-10-20T12:00:00.000Z');
const DAY = 86_400_000;

beforeEach(() => {
  vi.clearAllMocks();
  for (const mock of Object.values(mocks)) mock.mockResolvedValue({ count: 2 });
  mocks.accounts.mockResolvedValue([]);
  env.OWNER_ACCOUNT_EMAILS = ['owner@example.com'];
});

describe('housekeeping', () => {
  it('deletes only what has stopped meaning anything, by age', async () => {
    const result = await runHousekeeping(NOW);

    const week = new Date(NOW.getTime() - 7 * DAY);
    const retention = new Date(NOW.getTime() - env.HOUSEKEEPING_RETENTION_DAYS * DAY);
    expect(mocks.sessions).toHaveBeenCalledWith({
      where: { OR: [{ expires_at: { lt: week } }, { revoked_at: { lt: week } }] },
    });
    expect(mocks.rateLimitHits).toHaveBeenCalledWith({ where: { expires_at: { lt: NOW } } });
    expect(mocks.notifications).toHaveBeenCalledWith({
      where: { created_at: { lt: retention } },
    });
    // A run still going is never housekeeping's to delete, however old it looks.
    expect(mocks.activityRuns).toHaveBeenCalledWith({
      where: { state: { not: 'RUNNING' }, finished_at: { lt: retention } },
    });
    expect(mocks.syncRuns).toHaveBeenCalledWith({
      where: { status: { not: 'RUNNING' }, started_at: { lt: retention } },
    });
    expect(result).toEqual({
      sessions: 2,
      oauthStates: 2,
      rateLimitHits: 2,
      notifications: 2,
      activityRuns: 2,
      syncRuns: 2,
      outsideWindow: 0,
    });
  });

  // Without an owner configured, the owner's mailbox would look like a beta mailbox and lose its
  // older mail. Deleting is irreversible, so nothing is deleted.
  it('deletes no mail at all while no owner is configured', async () => {
    env.OWNER_ACCOUNT_EMAILS = [];
    mocks.accounts.mockResolvedValue([
      { id: 'owner', email: 'owner@example.com', created_at: new Date(), mail_history_days: null },
    ]);

    const result = await runHousekeeping(NOW);

    expect(mocks.messages).not.toHaveBeenCalled();
    expect(result.outsideWindow).toBe(0);
  });

  // The sync never stores older mail and the classifier never reads it; this removes whatever got
  // in anyway, for every mailbox but the owner's.
  it('removes mail older than a beta mailbox`s window and leaves the owner`s alone', async () => {
    const created = new Date('2026-10-01T00:00:00.000Z');
    mocks.accounts.mockResolvedValue([
      { id: 'beta', email: 'friend@example.com', created_at: created, mail_history_days: null },
      { id: 'owner', email: 'owner@example.com', created_at: created, mail_history_days: null },
    ]);
    mocks.messages.mockResolvedValue({ count: 7 });

    const result = await runHousekeeping(NOW);

    expect(mocks.messages).toHaveBeenCalledTimes(1);
    expect(mocks.messages).toHaveBeenCalledWith({
      where: {
        connected_google_account_id: 'beta',
        internal_date: { lt: new Date(created.getTime() - env.MAIL_HISTORY_DAYS * DAY) },
      },
    });
    expect(result.outsideWindow).toBe(7);
  });
});
