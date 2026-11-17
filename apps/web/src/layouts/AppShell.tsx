import { useCallback } from 'react';
import { motion } from 'motion/react';
import { FolderTree, History, Inbox, Search, Star } from 'lucide-react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

import { ConnectGmailScreen } from '@web/components/app/ConnectGmailScreen';
import { IslandNav, MenuButton, type NavDestination } from '@web/components/app/IslandNav';
import { IslandWindow } from '@web/components/app/IslandWindow';
import { useIslandWindow, type IslandView } from '@web/components/app/islandWindowState';
import { NotificationCenter } from '@web/components/app/NotificationCenter';
import { useSignOut } from '@web/components/app/SignOutDialog';
import { ServerWakeNotice } from '@web/components/app/ServerWakeNotice';
import { useAuth } from '@web/context/useAuth';
import { useIslandTransition } from '@web/lib/motion';

/**
 * One layout, one breakpoint. Above 768px the navigation is the island: a dark pill floating at
 * the top centre over a centred column, instead of a side panel that made the app read as one huge
 * window. Below it, the same pill sits at the bottom as the tab bar, where a thumb reaches it.
 *
 * The five tabs are what is opened every day. Everything else — notifications first — opens in
 * the island's window from the menu button, which carries the unread count so new mail is
 * visible from anywhere without spending a sixth tab on it.
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

/** Screens that work without a mailbox: setting one up, the menu, and the account itself. */
const NO_MAILBOX_NEEDED = new Set(['/setup', '/menu', '/account']);

export function AppShell() {
  const { user, gmailConnection } = useAuth();
  const { requestSignOut, dialog: signOutDialog } = useSignOut();
  const { pathname } = useLocation();
  const islandWindow = useIslandWindow();
  const transition = useIslandTransition();
  const { view, open, close } = islandWindow;

  // The menu button puts away whatever the window shows; the photo toggles account and privacy.
  const toggle = useCallback(
    (target: IslandView) => {
      const shown = target === 'home' ? view !== null : view === 'account';
      if (shown) close();
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

  return (
    <div className="shell">
      <NotificationCenter />
      {signOutDialog}
      <IslandNav destinations={NAV} view={view} onToggle={toggle} />
      <IslandWindow
        view={view}
        onShow={islandWindow.show}
        onClose={close}
        onSignOut={signOutFromWindow}
      />

      <main className="shell__main">
        <div className="shell__column">
          {/* On a phone the island is at the bottom, so the menu sits at the top of the screen. */}
          <div className="shell__toolbar">
            <MenuButton
              className="menu-button"
              expanded={view !== null}
              onToggle={() => toggle('home')}
            />
          </div>
          {/* On a desktop the island says this itself. */}
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
