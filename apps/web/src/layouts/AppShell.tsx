import { useCallback } from 'react';
import { motion } from 'motion/react';
import { FolderTree, History, Inbox, LogOut, Menu, Search, Shield, Star } from 'lucide-react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

import { Avatar } from '@web/components/Avatar';
import { ThemeToggle } from '@web/components/ThemeToggle';
import { ConnectGmailScreen } from '@web/components/app/ConnectGmailScreen';
import { DesktopIsland } from '@web/components/app/DesktopIsland';
import { IslandWindow } from '@web/components/app/IslandWindow';
import { MenuButton, UnreadBadge } from '@web/components/app/MenuButton';
import {
  useIslandWindow,
  type IslandView,
  type NavDestination,
} from '@web/components/app/islandWindowState';
import { NotificationCenter } from '@web/components/app/NotificationCenter';
import { useSignOut } from '@web/components/app/SignOutDialog';
import { ServerWakeNotice } from '@web/components/app/ServerWakeNotice';
import { useAuth } from '@web/context/useAuth';
import { useAppLayout } from '@web/lib/appLayout';
import { useIslandTransition } from '@web/lib/motion';
import { useNotificationFeed } from '@web/queries/notifications';

/**
 * Three shapes, one set of screens.
 *
 * - **The installed desktop app** (`useAppLayout() === 'app'`): an empty window with the island
 *   floating on it — draggable, Dock-style — and each screen opening in a tray from the island.
 * - **The AMO Island desktop program** (`'island'`): the same island with no window around it,
 *   on the Windows desktop itself.
 * - **A browser tab on a computer**: the side panel on the left beside a max-width column.
 * - **A phone**: the same pill as the island, floating at the bottom as the tab bar, with the menu
 *   at the top opening a small window. The stylesheet switches between these two at 768px.
 *
 * The five tabs are what is opened every day. Everything else — notifications first — sits
 * behind the menu, which carries the unread count so new mail is visible from anywhere without
 * spending a sixth tab on it.
 *
 * Setup is deliberately not in here. It is a path you walk once, linked to from wherever an
 * account turns out not to be ready; a permanent tab for it would be clutter forever after.
 */
const NAV: readonly NavDestination[] = [
  { to: '/inbox', label: 'Inbox', Icon: Inbox },
  { to: '/find', label: 'Find', Icon: Search },
  { to: '/favorites', label: 'Favourites', Icon: Star },
  { to: '/folders', label: 'Folders', Icon: FolderTree },
  { to: '/activity', label: 'Activity', Icon: History },
];

/** Screens that work without a mailbox: setting one up, the menu, the account, and pairing. */
const NO_MAILBOX_NEEDED = new Set(['/setup', '/menu', '/account', '/connect-island']);

/** The side panel's way into the menu: a page of its own, as it always was in a browser. */
function MenuLink() {
  const feed = useNotificationFeed();
  const unread = feed.data?.unreadCount ?? 0;
  return (
    <NavLink
      to="/menu"
      className={({ isActive }) => `menu-button${isActive ? ' menu-button--active' : ''}`}
      aria-label={unread > 0 ? `Menu, ${unread} unread notifications` : 'Menu'}
      title="Menu"
    >
      <Menu aria-hidden="true" strokeWidth={1.75} />
      <UnreadBadge />
    </NavLink>
  );
}

export function AppShell() {
  const { user, gmailConnection } = useAuth();
  const { requestSignOut, dialog: signOutDialog } = useSignOut();
  const { pathname } = useLocation();
  const layout = useAppLayout();
  const islandWindow = useIslandWindow();
  const transition = useIslandTransition();
  const { view, open, close } = islandWindow;

  // The menu button puts away whatever the window shows.
  const toggle = useCallback(
    (target: IslandView) => {
      if (view !== null) close();
      else open(target);
    },
    [close, open, view],
  );

  const signOutFromWindow = useCallback(() => {
    close(false);
    requestSignOut();
  }, [close, requestSignOut]);

  // Only an answer from the server counts. A status request that failed is not proof that
  // Gmail is disconnected, and telling a connected person to connect would be its own bug.
  const answered = gmailConnection !== null && gmailConnection.status !== 'ERROR';
  const needsGmail =
    answered && (!gmailConnection.connected || gmailConnection.requiresReauthentication);
  const gated = needsGmail && !NO_MAILBOX_NEEDED.has(pathname);

  if (!user) return null;

  // Every mailbox screen asks the API for a mailbox; without one, each request can only fail.
  // The step that is missing is shown instead of the screen.
  const screen = gated ? (
    <ConnectGmailScreen reconnect={Boolean(gmailConnection?.requiresReauthentication)} />
  ) : (
    <Outlet />
  );

  if (layout === 'app' || layout === 'island') {
    return (
      <div className="shell" data-layout={layout}>
        <NotificationCenter />
        {signOutDialog}
        <DesktopIsland
          destinations={NAV}
          screen={screen}
          onSignOut={requestSignOut}
          companion={layout === 'island'}
        />
      </div>
    );
  }

  return (
    <div className="shell" data-layout="web">
      <NotificationCenter />
      {signOutDialog}
      <nav className="shell__rail" aria-label="Primary">
        {/* Whose mail this is, first and large enough to recognise at a glance. */}
        <div className="shell__profile">
          <Avatar name={user.displayName} email={user.email} src={user.avatarUrl} size="medium" />
          <div className="shell__identity">
            {user.displayName ? <span className="shell__name">{user.displayName}</span> : null}
            <span className="shell__email">{user.email}</span>
          </div>
        </div>
        <MenuLink />
        <ul className="shell__nav">
          {NAV.map(({ to, label, Icon }) => (
            <li key={to}>
              <NavLink
                to={to}
                className={({ isActive }) => `nav-item${isActive ? ' nav-item--active' : ''}`}
              >
                <Icon aria-hidden="true" strokeWidth={1.5} />
                <span>{label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="shell__account">
          <ThemeToggle variant="compact" className="shell__theme" />
          <div className="shell__account-actions">
            <NavLink
              to="/account"
              className={({ isActive }) =>
                `button button--icon${isActive ? ' button--icon-active' : ''}`
              }
              aria-label="Account and privacy"
              title="Account and privacy"
            >
              <Shield aria-hidden="true" strokeWidth={1.5} />
            </NavLink>
            <button
              className="button button--icon"
              type="button"
              onClick={requestSignOut}
              aria-label="Log out"
              title="Log out"
            >
              <LogOut aria-hidden="true" strokeWidth={1.5} />
            </button>
          </div>
        </div>
      </nav>
      <IslandWindow
        view={view}
        onShow={islandWindow.show}
        onClose={close}
        onSignOut={signOutFromWindow}
      />

      <main className="shell__main">
        <div className="shell__column">
          {/* On a phone the tab bar is at the bottom, so the menu sits at the top of the screen. */}
          <div className="shell__toolbar">
            <MenuButton
              className="menu-button"
              expanded={view !== null}
              onToggle={() => toggle('home')}
            />
          </div>
          <ServerWakeNotice />
          {screen}
        </div>
      </main>

      <nav className="shell__tabs" aria-label="Primary">
        {NAV.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => `tab-item${isActive ? ' tab-item--active' : ''}`}
          >
            {({ isActive }) => (
              <>
                {isActive ? (
                  <motion.span
                    layoutId="tab-selection"
                    className="tab-item__selection"
                    transition={transition}
                  />
                ) : null}
                <Icon aria-hidden="true" strokeWidth={1.5} />
                <span>{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
