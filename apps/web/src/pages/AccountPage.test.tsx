import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  user: {
    id: 'user-1',
    email: 'person@example.com',
    displayName: 'Person',
    avatarUrl: null,
    status: 'ACTIVE' as const,
    gmailConnected: true,
    tutorialCompletedAt: null,
  },
  gmailConnection: {
    connected: true,
    email: 'person@example.com',
    status: 'CONNECTED' as const,
    grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    requiresReauthentication: false,
  },
  isDisconnecting: false,
  disconnectGmail: vi.fn(),
  logoutAll: vi.fn(),
}));

vi.mock('@web/context/useAuth', () => ({ useAuth: () => auth }));

import { AccountPage } from './AccountPage';

describe('AccountPage', () => {
  beforeEach(() => {
    auth.disconnectGmail.mockReset();
    auth.logoutAll.mockReset();
  });

  it('surfaces privacy controls without exposing a credential value', () => {
    render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Account & privacy' })).toBeInTheDocument();
    expect(screen.getByText('HttpOnly cookie')).toBeInTheDocument();
    expect(screen.getByText('None stored')).toBeInTheDocument();
    expect(screen.queryByText(/refresh_token|access_token|Bearer/i)).not.toBeInTheDocument();
  });

  it('requires confirmation before disconnecting Gmail', async () => {
    auth.disconnectGmail.mockResolvedValue(undefined);
    render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /disconnect gmail/i }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('MailMind will revoke the Gmail grant');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect Gmail' }));
    expect(auth.disconnectGmail).toHaveBeenCalledTimes(1);
  });
});
