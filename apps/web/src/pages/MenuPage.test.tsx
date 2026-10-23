import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getNotifications: vi.fn(),
  logout: vi.fn(),
  deleteAccount: vi.fn(),
}));

vi.mock('@web/services/http', () => ({
  api: { getNotifications: mocks.getNotifications, deleteAccount: mocks.deleteAccount },
}));
vi.mock('@web/context/useAuth', () => ({
  useAuth: () => ({
    user: { displayName: 'Ada Lovelace', email: 'ada@gmail.com', avatarUrl: null },
    logout: mocks.logout,
    gmailConnection: { connected: true, email: 'ada@gmail.com', status: 'CONNECTED' },
  }),
}));

import { renderScreen } from '@web/test/renderScreen';
import { MenuPage } from './MenuPage';

describe('MenuPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getNotifications.mockResolvedValue({ items: [], unreadCount: 3, nextCursor: null });
    mocks.logout.mockResolvedValue(undefined);
  });

  it('leads to notifications first, with the unread count on it', async () => {
    renderScreen(<MenuPage />, '/menu');

    const notifications = screen.getByRole('link', { name: /Notifications/ });
    expect(notifications).toHaveAttribute('href', '/notifications');
    expect(await screen.findByLabelText('3 unread')).toBeInTheDocument();
  });

  it('holds the rest of the app behind it', () => {
    renderScreen(<MenuPage />, '/menu');

    expect(screen.getByRole('link', { name: /Activity/ })).toHaveAttribute('href', '/activity');
    expect(screen.getByRole('link', { name: /Account and privacy/ })).toHaveAttribute(
      'href',
      '/account',
    );
    expect(screen.getByRole('link', { name: /Send feedback/ })).toHaveAttribute(
      'href',
      '/feedback',
    );
  });

  // Signing out is where a person decides what happens to their data.
  it('asks whether to keep the data, and keeps it when asked to', async () => {
    renderScreen(<MenuPage />, '/menu');
    await userEvent.click(screen.getByRole('button', { name: /Log out/ }));

    expect(screen.getByRole('dialog', { name: 'Sign out of AMO' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Keep my data' }));

    expect(mocks.logout).toHaveBeenCalledOnce();
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  });

  it('deletes everything only after a second, explicit tap', async () => {
    mocks.deleteAccount.mockResolvedValue({ success: true, connectedAccounts: 1 });
    renderScreen(<MenuPage />, '/menu');
    await userEvent.click(screen.getByRole('button', { name: /Log out/ }));

    await userEvent.click(screen.getByRole('button', { name: 'Delete my data' }));
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
    expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Yes, delete everything' }));
    expect(mocks.deleteAccount).toHaveBeenCalledOnce();
    expect(mocks.logout).toHaveBeenCalledOnce();
  });

  it('stays signed in and says so when the deletion fails', async () => {
    mocks.deleteAccount.mockRejectedValue(new Error('offline'));
    renderScreen(<MenuPage />, '/menu');
    await userEvent.click(screen.getByRole('button', { name: /Log out/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete my data' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, delete everything' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/still signed in/);
    expect(mocks.logout).not.toHaveBeenCalled();
  });
});
