import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: { value: {} as Record<string, unknown> },
  waking: { value: false },
  api: {
    getNotifications: vi.fn(),
    getPushConfig: vi.fn(),
    markNotificationsRead: vi.fn(),
    deleteAccount: vi.fn(),
  },
  push: {
    pushAvailability: vi.fn(),
    currentSubscription: vi.fn(),
    subscribeThisBrowser: vi.fn(),
    unsubscribeThisBrowser: vi.fn(),
  },
}));

vi.mock('@web/context/useAuth', () => ({ useAuth: () => mocks.auth.value }));
vi.mock('@web/services/http', () => ({
  api: mocks.api,
  getBackendRedirectUrl: () => 'https://api.example/integrations/google/connect',
}));
vi.mock('@web/lib/push', () => mocks.push);
vi.mock('@web/components/app/NotificationCenter', () => ({ NotificationCenter: () => null }));
vi.mock('@web/components/app/ServerWakeNotice', () => ({ ServerWakeNotice: () => null }));
vi.mock('@web/lib/serverWaking', () => ({
  useServerWaking: () => mocks.waking.value,
  SLOW_SERVER_MESSAGE: 'Starting up.',
  SLOW_SERVER_DELAY_MS: 4_000,
}));

import { renderScreen } from '@web/test/renderScreen';
import { AppShell } from './AppShell';

function connection(overrides: Record<string, unknown> = {}) {
  return {
    connected: true,
    email: 'someone@gmail.com',
    status: 'CONNECTED',
    grantedScopes: [],
    requiresReauthentication: false,
    ...overrides,
  };
}

function renderAt(path: string) {
  return renderScreen(
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/inbox" element={<p>Inbox content</p>} />
        <Route path="/activity" element={<p>Activity content</p>} />
        <Route path="/menu" element={<p>Menu content</p>} />
        <Route path="/setup" element={<p>Setup content</p>} />
      </Route>
    </Routes>,
    path,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.waking.value = false;
  mocks.auth.value = {
    user: { displayName: 'Someone', email: 'someone@gmail.com', avatarUrl: null },
    logout: vi.fn(),
    gmailConnection: connection(),
  };
  mocks.api.getNotifications.mockResolvedValue({ items: [], unreadCount: 2, nextCursor: null });
  mocks.api.getPushConfig.mockResolvedValue({ configured: false, publicKey: null });
  mocks.push.pushAvailability.mockReturnValue('default');
  mocks.push.currentSubscription.mockResolvedValue(null);
});

/*
 * Signing in and connecting Gmail are separate permissions. Someone who had only signed in landed
 * on an Inbox that said "Loading folders" forever and an Activity page of 409s; every mailbox
 * screen now shows the one missing step instead.
 */
describe('AppShell and a mailbox that is not connected', () => {
  it('shows the mailbox screens once Gmail is connected', () => {
    renderAt('/inbox');
    expect(screen.getByText('Inbox content')).toBeInTheDocument();
    expect(screen.queryByText(/connect gmail/i)).not.toBeInTheDocument();
  });

  it.each(['/inbox', '/activity'])('asks for Gmail instead of showing %s', (path) => {
    mocks.auth.value = { ...mocks.auth.value, gmailConnection: connection({ connected: false }) };
    renderAt(path);

    expect(screen.getByRole('heading', { name: /connect gmail/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect Gmail' })).toHaveAttribute(
      'href',
      'https://api.example/integrations/google/connect',
    );
    expect(screen.queryByText(/content/)).not.toBeInTheDocument();
  });

  it('leaves the screens that need no mailbox alone', () => {
    mocks.auth.value = { ...mocks.auth.value, gmailConnection: connection({ connected: false }) };
    renderAt('/menu');
    expect(screen.getByText('Menu content')).toBeInTheDocument();
  });

  it('asks for a reconnect when access expired', () => {
    mocks.auth.value = {
      ...mocks.auth.value,
      gmailConnection: connection({ connected: false, requiresReauthentication: true }),
    };
    renderAt('/inbox');
    expect(screen.getByRole('link', { name: 'Reconnect Gmail' })).toBeInTheDocument();
  });

  // A status request that failed is not proof of anything; telling a connected person to connect
  // would be its own bug.
  it('does not gate on a status it could not read', () => {
    mocks.auth.value = {
      ...mocks.auth.value,
      gmailConnection: connection({ connected: false, status: 'ERROR' }),
    };
    renderAt('/inbox');
    expect(screen.getByText('Inbox content')).toBeInTheDocument();
  });
});

/*
 * The side panel made the app read as one huge window. Its place is taken by the island at the
 * top centre, and what the panel held beyond the five screens opens in a small window from it.
 */
describe('the island', () => {
  // The island comes first; the phone's tab bar repeats the same five screens after the content.
  const island = () => within(screen.getAllByRole('navigation', { name: 'Primary' })[0]!);
  const menuButton = () => island().getByRole('button', { name: /^Menu/ });

  it('holds the five screens, the menu with its unread count, and the account', async () => {
    renderAt('/inbox');

    for (const name of ['Inbox', 'Find', 'Favourites', 'Folders', 'Activity']) {
      expect(island().getByRole('link', { name })).toBeInTheDocument();
    }
    expect(island().getByRole('link', { name: 'Inbox' })).toHaveAttribute('aria-current', 'page');
    expect(
      await island().findByRole('button', { name: 'Menu, 2 unread notifications' }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(island().getByRole('button', { name: 'Account and privacy' })).toBeInTheDocument();
  });

  it('opens notifications in a floating window over the screen, and goes back to the menu', async () => {
    renderAt('/inbox');
    await userEvent.click(menuButton());

    expect(menuButton()).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('dialog', { name: 'Menu' });
    await userEvent.click(within(menu).getByRole('button', { name: /Notifications/ }));

    const notifications = screen.getByRole('dialog', { name: 'Notifications' });
    expect(await within(notifications).findByText('Nothing new yet')).toBeInTheDocument();
    expect(
      within(notifications).getByRole('link', { name: 'Open as a full page' }),
    ).toHaveAttribute('href', '/notifications');
    // Shown in place: the screen underneath is still there.
    expect(screen.getByText('Inbox content')).toBeInTheDocument();

    await userEvent.click(within(notifications).getByRole('button', { name: 'Back to the menu' }));
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBeInTheDocument();
  });

  it('opens account and privacy straight from the photo', async () => {
    renderAt('/inbox');
    await userEvent.click(island().getByRole('button', { name: 'Account and privacy' }));

    const account = screen.getByRole('dialog', { name: 'Account & privacy' });
    expect(within(account).getByRole('button', { name: /Log out everywhere/ })).toBeInTheDocument();
  });

  it('puts the window away with Escape and gives focus back to the button', async () => {
    renderAt('/inbox');
    await userEvent.click(menuButton());
    expect(screen.getByRole('dialog', { name: 'Menu' })).toHaveFocus();

    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(menuButton()).toHaveFocus();
  });

  it('closes on a click outside it, and when another screen opens', async () => {
    renderAt('/inbox');
    await userEvent.click(menuButton());
    await userEvent.click(screen.getByText('Inbox content'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await userEvent.click(menuButton());
    await userEvent.click(island().getByRole('link', { name: 'Activity' }));
    expect(await screen.findByText('Activity content')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('signs out from the window through the same choice as everywhere else', async () => {
    renderAt('/inbox');
    await userEvent.click(menuButton());
    await userEvent.click(screen.getByRole('button', { name: 'Log out' }));

    expect(screen.getByRole('dialog', { name: 'Sign out of AMO' })).toBeInTheDocument();
  });

  it('grows to say the server is still starting', () => {
    mocks.waking.value = true;
    renderAt('/inbox');
    expect(island().getByRole('status')).toHaveTextContent('Starting up.');
  });
});
