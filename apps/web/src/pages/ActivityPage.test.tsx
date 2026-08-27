import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getActivityRuns: vi.fn() }));

vi.mock('@web/services/http', () => ({ api: mocks }));

import { apiError, renderScreen } from '@web/test/renderScreen';
import { ActivityPage } from './ActivityPage';
import type { ActivityRun } from '@web/types/activity';

function run(overrides: Partial<ActivityRun> & { id: string }): ActivityRun {
  return {
    kind: 'AUTOMATION_FILING',
    state: 'SUCCEEDED',
    trigger: 'MANUAL',
    processedCount: 250,
    totalCount: 250,
    counts: {},
    stopReason: null,
    errorCode: null,
    errorMessage: null,
    featureRunId: null,
    startedAt: '2026-08-20T02:00:00.000Z',
    finishedAt: '2026-08-20T02:04:00.000Z',
    durationMs: 240_000,
    ...overrides,
  };
}

describe('ActivityPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getActivityRuns.mockResolvedValue({ runs: [] });
  });

  it('lists runs newest first with their state and progress', async () => {
    mocks.getActivityRuns.mockResolvedValue({
      runs: [
        run({ id: 'a', kind: 'GMAIL_INITIAL_SYNC', state: 'RUNNING', processedCount: 120 }),
        run({ id: 'b' }),
      ],
    });
    renderScreen(<ActivityPage />, '/activity');

    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Initial sync');
    expect(items[0]).toHaveTextContent('Running');
    expect(items[0]).toHaveTextContent('120 / 250');
    expect(items[1]).toHaveTextContent('Succeeded');
  });

  // A stop is a run that did its work and quit for a reason, not a failure.
  it('shows a stop reason as its own state, with the reason spelled out', async () => {
    mocks.getActivityRuns.mockResolvedValue({
      runs: [
        run({
          id: 'a',
          state: 'STOPPED',
          stopReason: 'DAILY_BUDGET_REACHED',
          errorMessage: 'This run stopped at the daily Gemini budget.',
          counts: { messagesLabeled: 118, failed: 2 },
        }),
      ],
    });
    renderScreen(<ActivityPage />, '/activity');

    expect(await screen.findByText('Stopped')).toBeInTheDocument();
    expect(screen.getByText('DAILY_BUDGET_REACHED')).toBeInTheDocument();
    expect(screen.getByText(/This run stopped at the daily Gemini budget\./)).toBeInTheDocument();
    expect(screen.getByText('118')).toBeInTheDocument();
  });

  // The morning question is which of these ran while nobody was watching. A scheduled run that
  // reads like a manual one leaves an overnight failure indistinguishable from a button press.
  it('marks a run the scheduler started, so an overnight ending is recognisable', async () => {
    mocks.getActivityRuns.mockResolvedValue({
      runs: [
        run({
          id: 'a',
          trigger: 'SCHEDULED',
          state: 'STOPPED',
          stopReason: 'PROVIDER_RATE_LIMITED',
          errorMessage: 'Gemini rate-limited this run.',
        }),
        run({ id: 'b' }),
      ],
    });
    renderScreen(<ActivityPage />, '/activity');

    const items = await screen.findAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Scheduled');
    expect(items[0]).toHaveTextContent('Gemini rate-limited this run.');
    expect(items[1]).not.toHaveTextContent('Scheduled');
  });

  it('shows the error code and message on a failed run', async () => {
    mocks.getActivityRuns.mockResolvedValue({
      runs: [
        run({
          id: 'a',
          state: 'FAILED',
          errorCode: 'PROVIDER_RATE_LIMITED',
          errorMessage: 'Gemini is rate limited.',
          finishedAt: null,
        }),
      ],
    });
    renderScreen(<ActivityPage />, '/activity');

    expect(await screen.findByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('PROVIDER_RATE_LIMITED')).toBeInTheDocument();
    expect(screen.getByText(/Gemini is rate limited\./)).toBeInTheDocument();
  });

  it('renders an empty state rather than an empty list', async () => {
    renderScreen(<ActivityPage />, '/activity');
    expect(await screen.findByText('Nothing has run yet')).toBeInTheDocument();
  });

  it('surfaces a load failure inline with its code', async () => {
    mocks.getActivityRuns.mockRejectedValue(
      apiError('GMAIL_ACCOUNT_NOT_CONNECTED', 'Connect Gmail first.', 409),
    );
    renderScreen(<ActivityPage />, '/activity');

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText('GMAIL_ACCOUNT_NOT_CONNECTED')).toBeInTheDocument();
  });
});
