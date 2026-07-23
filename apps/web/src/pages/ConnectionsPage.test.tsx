import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionsPage } from './ConnectionsPage';

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConnectionsPage />
    </QueryClientProvider>,
  );
}

const authState = vi.hoisted(() => ({
  gmailConnection: null as null | {
    connected: boolean;
    email: string | null;
    status: 'CONNECTED' | 'REAUTH_REQUIRED' | 'REVOKED' | 'DISCONNECTED' | 'ERROR';
    grantedScopes: string[];
    requiresReauthentication: boolean;
    connectedAt?: string | null;
  },
  connectGmail: vi.fn(),
  disconnectGmail: vi.fn<() => Promise<void>>(),
  isDisconnecting: false,
  isRedirecting: false,
}));

vi.mock('@web/context/useAuth', () => ({ useAuth: () => authState }));

function setStatus(
  status: NonNullable<typeof authState.gmailConnection>['status'],
  connected = false,
) {
  authState.gmailConnection = {
    connected,
    email: connected ? 'ada@gmail.com' : null,
    status,
    grantedScopes: connected ? ['https://www.googleapis.com/auth/gmail.modify'] : [],
    requiresReauthentication: status === 'REAUTH_REQUIRED',
    connectedAt: connected ? '2026-07-20T10:00:00.000Z' : null,
  };
}

describe('ConnectionsPage', () => {
  beforeEach(() => {
    authState.connectGmail.mockReset();
    authState.disconnectGmail.mockReset();
    authState.isDisconnecting = false;
    authState.isRedirecting = false;
  });

  it.each([
    ['DISCONNECTED', 'Gmail is not connected'],
    ['REAUTH_REQUIRED', 'A fresh Google approval is needed.'],
    ['REVOKED', 'Gmail is no longer available.'],
    ['ERROR', 'Gmail could not be reached.'],
  ] as const)('renders the %s state safely', (status, heading) => {
    setStatus(status);
    renderPage();
    expect(screen.getByText(heading)).toBeInTheDocument();
  });

  it('renders connected account details with raw scopes behind disclosure', () => {
    setStatus('CONNECTED', true);
    renderPage();
    expect(screen.getByRole('heading', { name: 'ada@gmail.com' })).toBeInTheDocument();
    expect(screen.getByText('Technical permission details')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect Gmail' })).toBeInTheDocument();
  });

  it('starts the backend Gmail connection flow', async () => {
    const user = userEvent.setup();
    setStatus('DISCONNECTED');
    renderPage();
    await user.click(screen.getByRole('button', { name: 'Connect Gmail' }));
    expect(authState.connectGmail).toHaveBeenCalledTimes(1);
  });

  it('confirms and completes a Gmail disconnect', async () => {
    const user = userEvent.setup();
    authState.disconnectGmail.mockResolvedValue();
    setStatus('CONNECTED', true);
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Disconnect Gmail' }));
    expect(screen.getByRole('dialog', { name: 'Disconnect Gmail?' })).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: 'Disconnect Gmail' });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[1]!);
    expect(authState.disconnectGmail).toHaveBeenCalledTimes(1);
  });
});
