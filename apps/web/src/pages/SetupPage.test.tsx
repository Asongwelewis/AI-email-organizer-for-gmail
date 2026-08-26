import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getGmailStatus: vi.fn(),
  getGmailSyncStatus: vi.fn(),
  initializeGmailLabels: vi.fn(),
  initialGmailSync: vi.fn(),
  classifyFacets: vi.fn(),
}));

vi.mock('@web/services/http', () => ({
  api: mocks,
  getBackendRedirectUrl: () => 'https://api.example/integrations/google/connect',
}));

import { apiError, renderScreen } from '@web/test/renderScreen';
import { SetupPage } from './SetupPage';

const connection = (overrides = {}) => ({
  connected: true,
  email: 'user@example.com',
  status: 'CONNECTED',
  grantedScopes: [],
  requiresReauthentication: false,
  ...overrides,
});

const syncStatus = (overrides = {}) => ({
  status: 'IDLE',
  initialSyncCompleted: false,
  lastSuccessfulSyncAt: null,
  lastErrorCode: null,
  nextRetryAt: null,
  totalGmailMessages: 9525,
  syncedMessages: 0,
  classifiedMessages: 0,
  unprocessedMessages: 0,
  messageCount: 0,
  syncRunning: false,
  backfill: {},
  ...overrides,
});

/**
 * The first-run path, which is the thing that did not exist. Signing in landed on an empty Sorted
 * screen whose only route onwards answered 409, because Gmail had never been connected and no mail
 * had ever been synced.
 */
describe('SetupPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getGmailStatus.mockResolvedValue(connection({ connected: false }));
    mocks.getGmailSyncStatus.mockResolvedValue(syncStatus());
    mocks.initializeGmailLabels.mockResolvedValue({ success: true, labelsUpserted: 12 });
    mocks.initialGmailSync.mockResolvedValue({ runId: 'run-1', state: 'RUNNING' });
    mocks.classifyFacets.mockResolvedValue({ runId: 'run-2', state: 'RUNNING' });
  });

  // Each step is gated on the one before it. Offering an action the account is not ready for is
  // exactly the failure this screen replaces.
  it('offers only the connect step until Gmail is connected', async () => {
    renderScreen(<SetupPage />, '/setup');

    expect(await screen.findByRole('link', { name: /connect gmail/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start reading/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sort my mail/i })).not.toBeInTheDocument();
  });

  it('moves on to reading the mailbox once Gmail is connected', async () => {
    mocks.getGmailStatus.mockResolvedValue(connection());
    renderScreen(<SetupPage />, '/setup');

    expect(await screen.findByRole('button', { name: /start reading/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^connect gmail$/i })).not.toBeInTheDocument();
  });

  // A sync stores label ids per message; without the label table those ids are opaque numbers the
  // rest of the app cannot render. So labels are initialised first, every time.
  it('initialises labels before starting the first sync', async () => {
    mocks.getGmailStatus.mockResolvedValue(connection());
    renderScreen(<SetupPage />, '/setup');

    await userEvent.click(await screen.findByRole('button', { name: /start reading/i }));

    await waitFor(() => expect(mocks.initialGmailSync).toHaveBeenCalled());
    expect(mocks.initializeGmailLabels.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.initialGmailSync.mock.invocationCallOrder[0]!,
    );
  });

  it('reports progress against the mailbox while a sync is running', async () => {
    mocks.getGmailStatus.mockResolvedValue(connection());
    mocks.getGmailSyncStatus.mockResolvedValue(
      syncStatus({ syncRunning: true, syncedMessages: 1200 }),
    );
    renderScreen(<SetupPage />, '/setup');

    expect(await screen.findByText(/1,200 of 9,525/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /reading…/i })).toBeDisabled();
  });

  it('offers sorting only once the mailbox has been read', async () => {
    mocks.getGmailStatus.mockResolvedValue(connection());
    mocks.getGmailSyncStatus.mockResolvedValue(syncStatus({ initialSyncCompleted: true }));
    renderScreen(<SetupPage />, '/setup');

    await userEvent.click(await screen.findByRole('button', { name: /sort my mail/i }));

    await waitFor(() => expect(mocks.classifyFacets).toHaveBeenCalled());
    expect(await screen.findByText(/sorting started/i)).toBeInTheDocument();
  });

  // The screen says what broke and carries the server's code, rather than a toast that leaves.
  it('shows a failure where it happened', async () => {
    mocks.getGmailStatus.mockResolvedValue(connection());
    mocks.getGmailSyncStatus.mockResolvedValue(syncStatus({ initialSyncCompleted: true }));
    mocks.classifyFacets.mockRejectedValue(
      apiError('AUTOMATION_NOT_CONFIGURED', 'Gemini is not configured.', 503),
    );
    renderScreen(<SetupPage />, '/setup');

    await userEvent.click(await screen.findByRole('button', { name: /sort my mail/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('AUTOMATION_NOT_CONFIGURED');
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
