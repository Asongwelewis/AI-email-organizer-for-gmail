import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAutomationStatus: vi.fn(),
}));

vi.mock('@web/services/http', () => ({ api: mocks }));

import { renderScreen } from '@web/test/renderScreen';
import { AutomationPanel } from './AutomationPanel';
import type { AutomationStatus } from '@web/types/automation';

function status(overrides: Partial<AutomationStatus> = {}): AutomationStatus {
  return {
    gmailConnected: true,
    requiresReauthentication: false,
    enabled: true,
    running: false,
    nextRunAt: '2026-08-26T14:00:00.000Z',
    retryAt: null,
    lastErrorCode: null,
    lastRun: null,
    usageToday: {
      providerCalls: 12,
      inputTokens: 1200,
      cachedInputTokens: 0,
      outputTokens: 400,
      estimatedCostMicrousd: 2000,
      messagesLabeled: 0,
      messagesSorted: 118,
    },
    watch: { intervalSeconds: 60, lastCheckedAt: new Date(Date.now() - 2 * 60_000).toISOString() },
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
 * Now that mail is sorted as it arrives, that answer is "watching, checked a moment ago".
 */
describe('AutomationPanel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getAutomationStatus.mockResolvedValue(status());
  });

  it('says it is watching for new mail, how often, and when it last looked', async () => {
    renderScreen(<AutomationPanel />);

    expect(await screen.findByText('Watching for new mail')).toBeInTheDocument();
    expect(screen.getByText(/checks every minute · last checked 2 min ago/i)).toBeInTheDocument();
    expect(screen.getByText(/next full run/i)).toBeInTheDocument();
  });

  // With the Gmail export off by default, "filed" is always zero; "sorted" is what says it works.
  it('counts what was sorted today and what it cost', async () => {
    renderScreen(<AutomationPanel />);

    expect(await screen.findByText('Sorted today')).toBeInTheDocument();
    expect(screen.getByText('118')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  /*
   * The buttons are gone on purpose: mail is checked every minute and the full job runs twice a
   * day, so asking a person to do either by hand only invited them to do what was about to happen.
   */
  it('offers no button to run or check by hand', async () => {
    renderScreen(<AutomationPanel />);

    await screen.findByText('Watching for new mail');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('says a full run is in progress while one is', async () => {
    mocks.getAutomationStatus.mockResolvedValue(status({ running: true }));
    renderScreen(<AutomationPanel />);

    expect(await screen.findByText('Full run in progress')).toBeInTheDocument();
  });

  it('does not claim to watch when the watcher is turned off on the server', async () => {
    mocks.getAutomationStatus.mockResolvedValue(
      status({ watch: { intervalSeconds: 0, lastCheckedAt: null } }),
    );
    renderScreen(<AutomationPanel />);

    expect(await screen.findByText('Scheduled')).toBeInTheDocument();
    expect(screen.queryByText(/checks every/i)).not.toBeInTheDocument();
  });

  // The flag being off is the single most important thing this panel can say. It was the standing
  // mitigation while two filing engines existed, and an account left that way looks merely idle.
  it('says so plainly when automation is switched off on the server', async () => {
    mocks.getAutomationStatus.mockResolvedValue(
      status({ enabled: false, nextRunAt: null, disabledReason: 'AUTOMATION_DISABLED' }),
    );
    renderScreen(<AutomationPanel />);

    expect(await screen.findByText('Automation is off')).toBeInTheDocument();
    expect(screen.getByText(/switched off for AMO right now/)).toBeInTheDocument();
    expect(screen.queryByText(/checks every/i)).not.toBeInTheDocument();
  });

  /**
   * Three separate things switch automation off, and each gets its own sentence. They are written
   * for whoever is signed in: a friend who signed up was shown "GEMINI_API_KEY is not set on the
   * server", an operator's setting they could do nothing about.
   */
  it('explains a server that cannot sort yet without naming its settings', async () => {
    mocks.getAutomationStatus.mockResolvedValue(
      status({ enabled: false, nextRunAt: null, disabledReason: 'AUTOMATION_NOT_CONFIGURED' }),
    );
    renderScreen(<AutomationPanel />);

    expect(await screen.findByText(/nothing you need to do/)).toBeInTheDocument();
    expect(screen.queryByText(/GEMINI|AUTOMATION_ENABLED/)).not.toBeInTheDocument();
  });

  it('says the account is paused when the switch is the account, not the server', async () => {
    mocks.getAutomationStatus.mockResolvedValue(
      status({ enabled: false, nextRunAt: null, disabledReason: 'ACCOUNT_PAUSED' }),
    );
    renderScreen(<AutomationPanel />);

    expect(await screen.findByText(/paused for your account/)).toBeInTheDocument();
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
});
