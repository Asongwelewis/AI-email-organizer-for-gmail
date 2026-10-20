import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessions: vi.fn(),
  oauthStates: vi.fn(),
  rateLimitHits: vi.fn(),
  notifications: vi.fn(),
  activityRuns: vi.fn(),
  syncRuns: vi.fn(),
}));

vi.mock('../src/database/prisma.js', () => ({
  prisma: {
    sessions: { deleteMany: mocks.sessions },
    oauth_states: { deleteMany: mocks.oauthStates },
    rate_limit_hits: { deleteMany: mocks.rateLimitHits },
    notifications: { deleteMany: mocks.notifications },
    activity_runs: { deleteMany: mocks.activityRuns },
    gmail_sync_runs: { deleteMany: mocks.syncRuns },
  },
}));

const { env } = await import('../src/config/env.js');
const { runHousekeeping } = await import('../src/services/housekeeping.js');

const NOW = new Date('2026-10-20T12:00:00.000Z');
const DAY = 86_400_000;

beforeEach(() => {
  vi.clearAllMocks();
  for (const mock of Object.values(mocks)) mock.mockResolvedValue({ count: 2 });
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
    });
  });
});
