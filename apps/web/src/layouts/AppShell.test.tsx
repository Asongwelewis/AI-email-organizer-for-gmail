import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: { value: {} as Record<string, unknown> },
  waking: { value: false },
  layout: { value: 'web' as 'web' | 'app' },
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
vi.mock('@web/lib/appLayout', () => ({ useAppLayout: () => mocks.layout.value }));
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
  mocks.layout.value = 'web';
  window.localStorage.clear();
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
 * In a browser the side panel is back as it was; a phone opens the menu as a small window over
 * the screen instead of leaving it.
 */
describe('in a browser', () => {
  const sidePanel = () => within(screen.getAllByRole('navigation', { name: 'Primary' })[0]!);
  // The phone's menu: a button at the top of the screen. The side panel's is a link to a page.
  const menuButton = () => screen.getByRole('button', { name: /^Menu/ });

  it('keeps the side panel: the five screens, the menu page, account and log out', async () => {
    renderAt('/inbox');

    for (const name of ['Inbox', 'Find', 'Favourites', 'Folders', 'Activity']) {
      expect(sidePanel().getByRole('link', { name })).toBeInTheDocument();
    }
    expect(
      await sidePanel().findByRole('link', { name: 'Menu, 2 unread notifications' }),
    ).toHaveAttribute('href', '/menu');
    expect(sidePanel().getByRole('link', { name: 'Account and privacy' })).toHaveAttribute(
      'href',
      '/account',
    );
    expect(sidePanel().getByRole('button', { name: 'Log out' })).toBeInTheDocument();
    expect(screen.queryByText(/Choose a screen on the island/)).not.toBeInTheDocument();
  });

  it('opens notifications in a floating window on a phone, and goes back to the menu', async () => {
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
    await userEvent.click(sidePanel().getByRole('link', { name: 'Activity' }));
    expect(await screen.findByText('Activity content')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('signs out from the window through the same choice as everywhere else', async () => {
    renderAt('/inbox');
    await userEvent.click(menuButton());
    const menu = screen.getByRole('dialog', { name: 'Menu' });
    await userEvent.click(within(menu).getByRole('button', { name: 'Log out' }));

    expect(screen.getByRole('dialog', { name: 'Sign out of AMO' })).toBeInTheDocument();
  });
});

/*
 * Installed from Chrome on a computer, AMO is an island floating on an empty window. Tapping a
 * screen opens it in a small tray from the island, rather than turning the whole window into it.
 */
describe('as the installed desktop app', () => {
  beforeEach(() => {
    mocks.layout.value = 'app';
  });

  const island = () => within(screen.getByRole('navigation', { name: 'Primary' }));

  it('floats the island on an empty window, with no side panel and no page', async () => {
    renderAt('/inbox');

    expect(screen.getAllByRole('navigation', { name: 'Primary' })).toHaveLength(1);
    for (const name of ['Inbox', 'Find', 'Favourites', 'Folders', 'Activity']) {
      expect(island().getByRole('link', { name })).toBeInTheDocument();
    }
    expect(
      await island().findByRole('button', { name: 'Menu, 2 unread notifications' }),
    ).toBeInTheDocument();
    expect(island().getByRole('button', { name: 'Account and privacy' })).toBeInTheDocument();
    expect(screen.getByText(/Choose a screen on the island/)).toBeInTheDocument();
    expect(screen.queryByText('Inbox content')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens a tapped screen in a tray, and the same tap puts it away', async () => {
    renderAt('/inbox');

    await userEvent.click(island().getByRole('link', { name: 'Activity' }));
    const tray = await screen.findByRole('dialog', { name: 'Activity' });
    expect(within(tray).getByText('Activity content')).toBeInTheDocument();

    await userEvent.click(island().getByRole('link', { name: 'Activity' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // The screen that is open reopens where it was.
    await userEvent.click(island().getByRole('link', { name: 'Activity' }));
    expect(await screen.findByRole('dialog', { name: 'Activity' })).toBeInTheDocument();
  });

  it('opens straight into the tray when it starts on a particular screen', () => {
    renderAt('/activity');
    expect(screen.getByRole('dialog', { name: 'Activity' })).toHaveTextContent('Activity content');
  });

  it('shows the menu and its screens in the tray, and Escape puts it away', async () => {
    renderAt('/inbox');
    await userEvent.click(island().getByRole('button', { name: /^Menu/ }));

    const menu = screen.getByRole('dialog', { name: 'Menu' });
    await userEvent.click(within(menu).getByRole('button', { name: /Notifications/ }));
    expect(await screen.findByText('Nothing new yet')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('opens account and privacy from the photo', async () => {
    renderAt('/inbox');
    await userEvent.click(island().getByRole('button', { name: 'Account and privacy' }));

    const account = screen.getByRole('dialog', { name: 'Account & privacy' });
    expect(within(account).getByRole('button', { name: /Log out everywhere/ })).toBeInTheDocument();
  });

  it('grows to say the server is still starting', () => {
    mocks.waking.value = true;
    renderAt('/inbox');
    // Under the island's row of buttons, on the island itself.
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Starting up.');
    expect(status.closest('.desk-island')).not.toBeNull();
  });
});
