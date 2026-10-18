import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  accountFindFirst: vi.fn(),
  settings: vi.fn(),
  state: vi.fn(),
  lastRun: vi.fn(),
  aggregate: vi.fn(),
  actionCount: vi.fn(),
  labelCount: vi.fn(),
  messageCount: vi.fn(),
  syncState: vi.fn(),
  lastCheckedAt: vi.fn(),
}));

vi.mock('../src/database/prisma.js', () => ({
  prisma: {
    connected_google_accounts: { findFirst: mocks.accountFindFirst },
    automation_settings: { findUnique: mocks.settings },
    automation_states: { findUnique: mocks.state },
    automation_runs: { findFirst: mocks.lastRun, aggregate: mocks.aggregate },
    automation_message_actions: { count: mocks.actionCount },
    user_labels: { count: mocks.labelCount },
    gmail_message_metadata: { count: mocks.messageCount },
    gmail_sync_states: { findUnique: mocks.syncState },
  },
}));
vi.mock('../src/features/automation/mail-watch.service.js', () => ({
  mailWatchService: { lastCheckedAt: mocks.lastCheckedAt },
}));

const { env } = await import('../src/config/env.js');
const { AutomationService } = await import('../src/features/automation/automation.service.js');

/**
 * What the automation panel shows now that there is no Run button: how often mail is checked, when
 * it last was, and how much was sorted today. With the Gmail export off by default, "filed today"
 * is always zero, so "sorted today" is the number that says the automation is working.
 */
describe('the automation status the panel reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accountFindFirst.mockResolvedValue({
      id: 'account-1',
      gmail_connected: true,
      connection_status: 'CONNECTED',
    });
    mocks.settings.mockResolvedValue(null);
    mocks.state.mockResolvedValue({ next_run_at: new Date('2026-10-18T14:00:00.000Z') });
    mocks.lastRun.mockResolvedValue(null);
    mocks.aggregate.mockResolvedValue({
      _sum: {
        provider_call_count: 3,
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        estimated_cost_microusd: 0,
        messages_labeled_count: 0,
        ai_classified_count: 25,
        pattern_reused_count: 17,
      },
    });
    mocks.actionCount.mockResolvedValue(0);
    mocks.labelCount.mockResolvedValue(0);
    mocks.messageCount.mockResolvedValue(0);
    mocks.syncState.mockResolvedValue({
      last_sync_completed_at: new Date('2026-10-18T11:50:00.000Z'),
    });
  });

  it('counts mail sorted today by rules and by the model together', async () => {
    mocks.lastCheckedAt.mockReturnValue(undefined);
    const status = await new AutomationService().status('user-1');
    expect(status.usageToday.messagesSorted).toBe(42);
    expect(status.nextRunAt).toBe('2026-10-18T14:00:00.000Z');
  });

  it('reports the watcher interval and when it last asked Gmail', async () => {
    mocks.lastCheckedAt.mockReturnValue(new Date('2026-10-18T11:59:00.000Z'));
    const status = await new AutomationService().status('user-1');
    expect(status.watch).toEqual({
      intervalSeconds: env.AUTOMATION_CHECK_INTERVAL_SECONDS,
      lastCheckedAt: '2026-10-18T11:59:00.000Z',
    });
  });

  // After a restart the in-memory time is gone; the last sync is the honest stand-in.
  it('falls back to the last sync when this process has not checked yet', async () => {
    mocks.lastCheckedAt.mockReturnValue(undefined);
    const status = await new AutomationService().status('user-1');
    expect(status.watch.lastCheckedAt).toBe('2026-10-18T11:50:00.000Z');
  });
});
