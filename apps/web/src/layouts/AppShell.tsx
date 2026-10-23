import { FolderTree, History, Inbox, LogOut, Menu, Search, Shield, Star } from 'lucide-react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

import { Avatar } from '@web/components/Avatar';
import { ConnectGmailScreen } from '@web/components/app/ConnectGmailScreen';
import { NotificationCenter } from '@web/components/app/NotificationCenter';
import { ServerWakeNotice } from '@web/components/app/ServerWakeNotice';
import { ThemeToggle } from '@web/components/ThemeToggle';
import { useAuth } from '@web/context/useAuth';
import { formatCount } from '@web/lib/format';
import { useNotificationFeed } from '@web/queries/notifications';

/**
 * One layout, one breakpoint. Below 768px the navigation is a bottom tab bar; above it, a left
 * rail beside a max-width column. The same destinations either way — a phone layout stretched
 * across a desktop is the failure this avoids.
 *
 * The five tabs are what is opened every day. Everything else — notifications first — sits behind
 * the menu icon on the left of every screen, which carries the unread count so new mail is visible
 * from anywhere without spending a sixth tab on it.
 *
 * Setup is deliberately not in here. It is a path you walk once, linked to from wherever an
 * account turns out not to be ready; a permanent tab for it would be clutter forever after.
 */
const NAV = [
  { to: '/inbox', label: 'Inbox', Icon: Inbox },
  { to: '/find', label: 'Find', Icon: Search },
  { to: '/favorites', label: 'Favourites', Icon: Star },
  { to: '/folders', label: 'Folders', Icon: FolderTree },
  { to: '/activity', label: 'Activity', Icon: History },
] as const;

/** Screens that work without a mailbox: setting one up, the menu, and the account itself. */
const NO_MAILBOX_NEEDED = new Set(['/setup', '/menu', '/account']);

function MenuButton() {
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
      {unread > 0 ? (
        <span className="menu-button__badge" aria-hidden="true">
          {unread > 99 ? '99+' : formatCount(unread)}
        </span>
      ) : null}
    </NavLink>
  );
}

export function AppShell() {
  const { user, logout, gmailConnection } = useAuth();
  const { pathname } = useLocation();
  // Only an answer from the server counts. A status request that failed is not proof that
  // Gmail is disconnected, and telling a connected person to connect would be its own bug.
  const answered = gmailConnection !== null && gmailConnection.status !== 'ERROR';
  const needsGmail =
    answered && (!gmailConnection.connected || gmailConnection.requiresReauthentication);
  const gated = needsGmail && !NO_MAILBOX_NEEDED.has(pathname);

  if (!user) return null;

  return (
    <div className="shell">
      <NotificationCenter />
      <nav className="shell__rail" aria-label="Primary">
        <span className="shell__brand">AMO</span>
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
          <Avatar name={user.displayName} email={user.email} src={user.avatarUrl} />
          <span className="shell__email">{user.email}</span>
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
            onClick={() => void logout()}
            aria-label="Log out"
          >
            <LogOut aria-hidden="true" strokeWidth={1.5} />
          </button>
        </div>
      </nav>

      <main className="shell__main">
        <div className="shell__column">
          {/* The menu sits on the left at every width. Below the rail's breakpoint the account
              row is hidden, so the theme control needs a home here as well. */}
          <div className="shell__toolbar">
            <MenuButton />
            <ThemeToggle variant="compact" className="shell__toolbar-theme" />
          </div>
          <ServerWakeNotice />
          {/* Every mailbox screen asks the API for a mailbox; without one, each request can
              only fail. The step that is missing is shown instead of the screen. */}
          {gated ? (
            <ConnectGmailScreen reconnect={Boolean(gmailConnection?.requiresReauthentication)} />
          ) : (
            <Outlet />
          )}
        </div>
      </main>

      <nav className="shell__tabs" aria-label="Primary">
        {NAV.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => `tab-item${isActive ? ' tab-item--active' : ''}`}
          >
            <Icon aria-hidden="true" strokeWidth={1.5} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
