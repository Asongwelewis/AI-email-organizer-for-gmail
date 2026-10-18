import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getNotifications: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('@web/services/http', () => ({ api: { getNotifications: mocks.getNotifications } }));
vi.mock('@web/context/useAuth', () => ({
  useAuth: () => ({
    user: { displayName: 'Ada Lovelace', email: 'ada@gmail.com', avatarUrl: null },
    logout: mocks.logout,
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

  it('logs out', async () => {
    renderScreen(<MenuPage />, '/menu');
    await userEvent.click(screen.getByRole('button', { name: /Log out/ }));
    expect(mocks.logout).toHaveBeenCalledOnce();
  });
});
