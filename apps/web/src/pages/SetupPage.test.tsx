import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getGmailStatus: vi.fn(),
  getOnboarding: vi.fn(),
  startOnboarding: vi.fn(),
  disconnectGmail: vi.fn(),
}));

vi.mock('@web/services/http', () => ({
  api: mocks,
  getBackendRedirectUrl: () => 'https://api.example/integrations/google/connect',
}));

import { renderScreen } from '@web/test/renderScreen';
import type { OnboardingStatus } from '@web/types/onboarding';
import { SetupPage } from './SetupPage';

const connection = (overrides = {}) => ({
  connected: true,
  email: 'user@example.com',
  status: 'CONNECTED',
  grantedScopes: [],
  requiresReauthentication: false,
  ...overrides,
});

const onboarding = (overrides: Partial<OnboardingStatus> = {}): OnboardingStatus => ({
  state: 'RUNNING',
  stage: 'SYNCING',
  processed: 0,
  total: null,
  sorted: 0,
  message: null,
  stopReason: null,
  runId: 'run-1',
  startedAt: '2026-10-20T09:00:00.000Z',
  finishedAt: null,
  completedAt: null,
  ...overrides,
});

/**
 * The first-run path. It used to be three buttons, and the last one failed for everyone but the
 * owner: a friend who signed up saw an error about a server key and no folders. Now there is one
 * button, Connect Gmail, and everything after it is progress the server reports on its own.
 */
describe('SetupPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getGmailStatus.mockResolvedValue(connection({ connected: false }));
    mocks.getOnboarding.mockResolvedValue(onboarding());
    mocks.startOnboarding.mockResolvedValue(onboarding());
    mocks.disconnectGmail.mockResolvedValue(undefined);
  });

  /**
   * Card 25. Google's grants are cumulative per client, so asking for less does not take the wider
   * scope back — an account connected while MailMind wrote labels keeps `gmail.modify` until the
   * grant is revoked. Holding an unused permission to alter someone's mail is worth offering to
   * give back rather than quietly keeping.
   */
  it('offers to narrow a grant that is wider than AMO uses', async () => {
    mocks.getGmailStatus.mockResolvedValue(
      connection({ holdsUnusedWriteScope: true, canModifyMail: true }),
    );
    renderScreen(<SetupPage />, '/setup');

    await userEvent.click(await screen.findByRole('button', { name: /narrow to read-only/i }));

    // Revoking is what disconnecting does, so narrowing is a disconnect and a fresh connect.
    await waitFor(() => expect(mocks.disconnectGmail).toHaveBeenCalled());
  });

  it('says nothing about narrowing when the grant is already read-only', async () => {
    mocks.getGmailStatus.mockResolvedValue(connection({ holdsUnusedWriteScope: false }));
    renderScreen(<SetupPage />, '/setup');

    await screen.findByText('Setting up your inbox');
    expect(screen.queryByRole('button', { name: /narrow to read-only/i })).not.toBeInTheDocument();
  });

  it('offers only the connect step until Gmail is connected', async () => {
    renderScreen(<SetupPage />, '/setup');

    expect(await screen.findByRole('link', { name: /connect gmail/i })).toBeInTheDocument();
    expect(screen.queryByText('Setting up your inbox')).not.toBeInTheDocument();
    // Nothing to ask the server about a mailbox that is not connected.
    expect(mocks.getOnboarding).not.toHaveBeenCalled();
  });

  it('shows setup moving on its own once Gmail is connected, with no button to press', async () => {
    mocks.getGmailStatus.mockResolvedValue(connection());
    mocks.getOnboarding.mockResolvedValue(
      onboarding({ stage: 'SYNCING', processed: 120, total: 2000 }),
    );
    renderScreen(<SetupPage />, '/setup');

    expect(await screen.findByText('Reading your recent mail')).toBeInTheDocument();
    expect(screen.getByText('120 of 2,000')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '120');
    expect(screen.queryByRole('button', { name: /start reading|sort my mail/i })).toBeNull();
  });

  // The server starts setup from the Gmail callback; this is the safety net for a start that was
  // lost, and it must ask once rather than on every poll.
  it('starts a setup nothing has started yet, once', async () => {
    mocks.getGmailStatus.mockResolvedValue(connection());
    mocks.getOnboarding.mockResolvedValue(onboarding({ state: 'PENDING', stage: null }));
    renderScreen(<SetupPage />, '/setup');

    await waitFor(() => expect(mocks.startOnboarding).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Reading your recent mail')).toBeInTheDocument();
  });

  it('marks earlier stages done and counts the sorting stage', async () => {
    mocks.getGmailStatus.mockResolvedValue(connection());
    mocks.getOnboarding.mockResolvedValue(
      onboarding({ stage: 'SORTING', processed: 75, total: 300 }),
    );
    renderScreen(<SetupPage />, '/setup');

    expect(await screen.findByText('Sorting your newest mail into folders')).toBeInTheDocument();
    expect(screen.getByText('75 of 300')).toBeInTheDocument();
    expect(screen.getAllByText(/— done/)).toHaveLength(2);
  });

  // What the friend saw was the operator's error. A person who signed up is told what is happening
  // and that it carries on by itself — never which environment variable is missing.
  it('explains a pause in words for the person, not the operator', async () => {
    mocks.getGmailStatus.mockResolvedValue(connection());
    mocks.getOnboarding.mockResolvedValue(
      onboarding({
        state: 'STOPPED',
        stage: 'SORTING',
        stopReason: 'SORTING_NOT_CONFIGURED',
        message:
          'Your mail is synced. Sorting has not been switched on for AMO yet — it will start on its own as soon as it is.',
      }),
    );
    renderScreen(<SetupPage />, '/setup');

    expect(await screen.findByText(/start on its own/i)).toBeInTheDocument();
    expect(screen.queryByText(/GEMINI|API key/i)).not.toBeInTheDocument();
    // Nothing a button here could fix.
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it('offers to try again after a pause a retry can fix', async () => {
    mocks.getGmailStatus.mockResolvedValue(connection());
    mocks.getOnboarding.mockResolvedValue(
      onboarding({
        state: 'STOPPED',
        stage: 'SORTING',
        stopReason: 'PROVIDER_UNUSABLE',
        message: 'Sorting hit a problem. It will try again in a few minutes.',
      }),
    );
    renderScreen(<SetupPage />, '/setup');

    await userEvent.click(await screen.findByRole('button', { name: /try again now/i }));
    await waitFor(() => expect(mocks.startOnboarding).toHaveBeenCalled());
  });

  it('sends a finished setup to the inbox', async () => {
    mocks.getGmailStatus.mockResolvedValue(connection());
    mocks.getOnboarding.mockResolvedValue(
      onboarding({ state: 'DONE', stage: 'DONE', completedAt: '2026-10-20T09:03:00.000Z' }),
    );
    renderScreen(<SetupPage />, '/setup');

    expect(await screen.findByText('Your folders are ready')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open my inbox/i })).toHaveAttribute('href', '/inbox');
  });

  it('asks for a reconnect rather than a first connect when access expired', async () => {
    mocks.getGmailStatus.mockResolvedValue(
      connection({ connected: false, requiresReauthentication: true }),
    );
    renderScreen(<SetupPage />, '/setup');

    expect(await screen.findByRole('link', { name: /reconnect gmail/i })).toBeInTheDocument();
    expect(screen.getByText(/access expired/i)).toBeInTheDocument();
  });
});
