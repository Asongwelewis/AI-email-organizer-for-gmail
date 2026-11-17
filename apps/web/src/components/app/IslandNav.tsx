import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Menu, type LucideIcon } from 'lucide-react';
import { NavLink } from 'react-router-dom';

import { Avatar } from '@web/components/Avatar';
import { ISLAND_WINDOW_ID, type IslandView } from '@web/components/app/islandWindowState';
import { useAuth } from '@web/context/useAuth';
import { formatCount } from '@web/lib/format';
import { useIslandTransition } from '@web/lib/motion';
import { SLOW_SERVER_MESSAGE, useServerWaking } from '@web/lib/serverWaking';
import { useNotificationFeed } from '@web/queries/notifications';

export interface NavDestination {
  to: string;
  label: string;
  Icon: LucideIcon;
}

/**
 * Opens the island's window. It carries the unread count, so new mail is visible from every
 * screen without spending a sixth tab on notifications.
 */
export function MenuButton({
  className,
  expanded,
  onToggle,
}: {
  className: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const feed = useNotificationFeed();
  const unread = feed.data?.unreadCount ?? 0;
  return (
    <button
      type="button"
      className={className}
      data-island-trigger
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-controls={expanded ? ISLAND_WINDOW_ID : undefined}
      aria-label={unread > 0 ? `Menu, ${unread} unread notifications` : 'Menu'}
      title="Menu"
      onClick={onToggle}
    >
      <Menu aria-hidden="true" strokeWidth={1.75} />
      {unread > 0 ? (
        <span className="menu-button__badge" aria-hidden="true">
          {unread > 99 ? '99+' : formatCount(unread)}
        </span>
      ) : null}
    </button>
  );
}

/**
 * The desktop navigation: one dark pill floating at the top centre, the way the island sits in
 * the middle of a MacBook's top edge. The menu on the left, the five everyday screens, and whose
 * mailbox this is on the right — the photo opens straight onto account and privacy.
 *
 * The selection slides between screens rather than jumping, and the island grows downward to say
 * something live — the server still waking — then shrinks back. Both are instant under reduced
 * motion (`useIslandTransition`).
 */
export function IslandNav({
  destinations,
  view,
  onToggle,
}: {
  destinations: readonly NavDestination[];
  view: IslandView | null;
  onToggle: (view: IslandView) => void;
}) {
  const { user } = useAuth();
  const waking = useServerWaking();
  const transition = useIslandTransition();
  const reduceMotion = useReducedMotion();

  if (!user) return null;

  return (
    <nav className="island" aria-label="Primary">
      <div className="island__row">
        <MenuButton
          className="island__button"
          expanded={view !== null}
          onToggle={() => onToggle('home')}
        />
        <span className="island__divider" aria-hidden="true" />
        <ul className="island__nav">
          {destinations.map(({ to, label, Icon }) => (
            <li key={to}>
              <NavLink
                to={to}
                className={({ isActive }) =>
                  `island__link${isActive ? ' island__link--active' : ''}`
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive ? (
                      <motion.span
                        layoutId="island-selection"
                        className="island__selection"
                        transition={transition}
                      />
                    ) : null}
                    <Icon aria-hidden="true" strokeWidth={1.75} />
                    <span>{label}</span>
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
        <span className="island__divider" aria-hidden="true" />
        <button
          type="button"
          className="island__button island__avatar"
          data-island-trigger
          aria-haspopup="dialog"
          aria-expanded={view === 'account'}
          aria-controls={view === 'account' ? ISLAND_WINDOW_ID : undefined}
          aria-label="Account and privacy"
          title={user.displayName ?? user.email}
          onClick={() => onToggle('account')}
        >
          <Avatar name={user.displayName} email={user.email} src={user.avatarUrl} />
        </button>
      </div>
      <AnimatePresence initial={false}>
        {waking ? (
          <motion.div
            key="waking"
            className="island__live"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={transition}
          >
            <p role="status" aria-live="polite">
              {SLOW_SERVER_MESSAGE}
            </p>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </nav>
  );
}
