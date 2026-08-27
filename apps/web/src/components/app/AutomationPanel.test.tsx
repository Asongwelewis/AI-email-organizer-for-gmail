import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAutomationStatus: vi.fn(),
  runAutomation: vi.fn(),
  incrementalGmailSync: vi.fn(),
}));

vi.mock('@web/services/http', () => ({ api: mocks }));

import { apiError, renderScreen } from '@web/test/renderScreen';
import { AutomationPanel } from './AutomationPanel';
import type { AutomationStatus } from '@web/types/automation';

function status(overrides: Partial<AutomationStatus> = {}): AutomationStatus {
  return {
    gmailConnected: true,
    requiresReauthentication: false,
    enabled: true,
    running: false,
    nextRunAt: '2026-08-26T02:00:00.000Z',
    retryAt: null,
    lastErrorCode: null,
    lastRun: null,
    usageToday: {
      providerCalls: 12,
      inputTokens: 1200,
      cachedInputTokens: 0,
      outputTokens: 400,
      estimatedCostMicrousd: 2000,
      messagesLabeled: 118,
    },
    pendingReviewCount: 4,
    approvedLabelCount: 9,
    labelsReady: true,
    backlogRemaining: 300,
    ...overrides,
  };
}

/**
 * `getAutomationStatus` existed since stage 2 and nothing rendered it, so the one question the
 * product's promise rests on — is it still running on its own? — had no answer in the interface.
 */
describe('AutomationPanel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getAutomationStatus.mockResolvedValue(status());
    mocks.runAutomation.mockResolvedValue({ runId: 'run-1', state: 'RUNNING' });
    mocks.incrementalGmailSync.mockResolvedValue({ synced: 3 });
  });

  it('answers when automation next runs, and what today already cost', async () => {
    renderScreen(<AutomationPanel />);

    expect(await screen.findByText(/next run/i)).toBeInTheDocument();
    expect(screen.getByText('118')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  // The flag being off is the single most important thing this panel can say. It was the standing
  // mitigation while two filing engines existed, and an account left that way looks merely idle.
  it('says so plainly when automation is switched off on the server', async () => {
    mocks.getAutomationStatus.mockResolvedValue(status({ enabled: false, nextRunAt: null }));
    renderScreen(<AutomationPanel />);

    expect(await screen.findByText('Automation is off')).toBeInTheDocument();
    expect(screen.getByText(/AUTOMATION_ENABLED is false/)).toBeInTheDocument();
  });

  // A backoff is not the schedule. Reading one as the other is how a stalled account looks healthy.
  it('shows a backoff separately from the next scheduled run', async () => {
    mocks.getAutomationStatus.mockResolvedValue(
      status({ retryAt: '2026-08-25T04:00:00.000Z', lastErrorCode: 'PROVIDER_RATE_LIMITED' }),
    );
    renderScreen(<AutomationPanel />);

    expect(await screen.findByText(/retrying/i)).toBeInTheDocument();
    expect(screen.getByText(/provider rate limited/i)).toBeInTheDocument();
  });

  it('runs the pipeline on demand', async () => {
    renderScreen(<AutomationPanel />);

    await userEvent.click(await screen.findByRole('button', { name: /run now/i }));

    await waitFor(() => expect(mocks.runAutomation).toHaveBeenCalled());
  });

  it('checks for new mail without a full run', async () => {
    renderScreen(<AutomationPanel />);

    await userEvent.click(await screen.findByRole('button', { name: /check for new mail/i }));

    await waitFor(() => expect(mocks.incrementalGmailSync).toHaveBeenCalled());
    expect(mocks.runAutomation).not.toHaveBeenCalled();
  });

  // Running with nowhere to file is a 409 waiting to happen, so the control is closed off and the
  // screen says which step is missing.
  it('refuses to offer a run when there is nowhere to file', async () => {
    mocks.getAutomationStatus.mockResolvedValue(status({ labelsReady: false }));
    renderScreen(<AutomationPanel />);

    expect(await screen.findByRole('button', { name: /run now/i })).toBeDisabled();
    expect(screen.getByText(/nowhere to file yet/i)).toBeInTheDocument();
  });

  it('shows the server code when a run cannot start', async () => {
    mocks.runAutomation.mockRejectedValue(
      apiError('AUTOMATION_DISABLED', 'Daily automation is disabled.', 503),
    );
    renderScreen(<AutomationPanel />);

    await userEvent.click(await screen.findByRole('button', { name: /run now/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('AUTOMATION_DISABLED');
  });
});
