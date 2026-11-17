import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Bell,
  ChevronLeft,
  ChevronRight,
  LogOut,
  Maximize2,
  MessageSquare,
  Shield,
  X,
} from 'lucide-react';
import { Link } from 'react-router-dom';

import { Avatar } from '@web/components/Avatar';
import { ThemeToggle } from '@web/components/ThemeToggle';
import {
  ISLAND_PANEL_TITLE_ID,
  ISLAND_WINDOW_ID,
  modalOpen,
  type IslandView,
} from '@web/components/app/islandWindowState';
import { useAuth } from '@web/context/useAuth';
import { formatCount } from '@web/lib/format';
import { usePopIn } from '@web/lib/motion';
import { AccountPage } from '@web/pages/AccountPage';
import { NotificationsPage } from '@web/pages/NotificationsPage';
import { useNotificationFeed } from '@web/queries/notifications';

const TITLES: Record<IslandView, string> = {
  home: 'Menu',
  notifications: 'Notifications',
  account: 'Account & privacy',
};

/** The full page each screen also has, for when the window is too small for it. */
const PAGES: Partial<Record<IslandView, string>> = {
  notifications: '/notifications',
  account: '/account',
};

export interface IslandPanelProps {
  view: IslandView;
  onShow: (view: IslandView) => void;
  onClose: (restoreFocus?: boolean) => void;
  onSignOut: () => void;
}

/**
 * What the island's window holds — the menu, and the notifications and account screens shown in
 * place — whichever frame it is in: the floating window on a phone, or the desktop app's tray.
 */
export function IslandPanel({ view, onShow, onClose, onSignOut }: IslandPanelProps) {
  const page = PAGES[view];
  return (
    <>
      <div className="island-window__bar">
        {view === 'home' ? null : (
          <button
            type="button"
            className="island-window__tool"
            onClick={() => onShow('home')}
            aria-label="Back to the menu"
            title="Back"
          >
            <ChevronLeft aria-hidden="true" strokeWidth={1.75} />
          </button>
        )}
        <h2 id={ISLAND_PANEL_TITLE_ID} className="island-window__title">
          {TITLES[view]}
        </h2>
        {page ? (
          <Link
            className="island-window__tool"
            to={page}
            onClick={() => onClose(false)}
            aria-label="Open as a full page"
            title="Open as a full page"
          >
            <Maximize2 aria-hidden="true" strokeWidth={1.75} />
          </Link>
        ) : null}
        <button
          type="button"
          className="island-window__tool"
          onClick={() => onClose()}
          aria-label="Close"
          title="Close"
        >
          <X aria-hidden="true" strokeWidth={1.75} />
        </button>
      </div>
      <div className="island-window__body">
        {view === 'home' ? <WindowMenu onShow={onShow} onSignOut={onSignOut} /> : null}
        {view === 'notifications' ? <NotificationsPage embedded /> : null}
        {view === 'account' ? <AccountPage embedded /> : null}
      </div>
    </>
  );
}

interface IslandWindowProps extends Omit<IslandPanelProps, 'view'> {
  view: IslandView | null;
}

/**
 * The small floating window the phone's menu button opens. It holds what the desktop side panel
 * does: the notifications, account and privacy, appearance, feedback and signing out — shown in
 * place, over whatever screen is open, rather than by leaving it.
 *
 * Not modal: the page behind stays usable, and a click outside or Escape puts the window away.
 */
export function IslandWindow({ view, onShow, onClose, onSignOut }: IslandWindowProps) {
  const ref = useRef<HTMLDivElement>(null);
  const pop = usePopIn();
  const isOpen = view !== null;

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !modalOpen()) onClose();
    };
    const onPointerDown = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element) || modalOpen()) return;
      // The buttons that open the window toggle it themselves.
      if (ref.current?.contains(target) || target.closest('[data-island-trigger]')) return;
      onClose(false);
    };
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [isOpen, onClose]);

  // Each view is announced by name and starts at its top.
  useEffect(() => {
    if (view) ref.current?.focus();
  }, [view]);

  return (
    <AnimatePresence>
      {view ? (
        <motion.div
          key="island-window"
          ref={ref}
          id={ISLAND_WINDOW_ID}
          className="island-window"
          role="dialog"
          aria-labelledby={ISLAND_PANEL_TITLE_ID}
          tabIndex={-1}
          {...pop}
        >
          <IslandPanel view={view} onShow={onShow} onClose={onClose} onSignOut={onSignOut} />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function WindowMenu({
  onShow,
  onSignOut,
}: {
  onShow: (view: IslandView) => void;
  onSignOut: () => void;
}) {
  const { user } = useAuth();
  const feed = useNotificationFeed();
  const unread = feed.data?.unreadCount ?? 0;

  return (
    <div className="island-menu">
      {user ? (
        <div className="menu-profile">
          <Avatar name={user.displayName} email={user.email} src={user.avatarUrl} />
          <div className="menu-profile__text">
            <p className="menu-profile__name">{user.displayName ?? user.email}</p>
            {user.displayName ? <p className="menu-profile__email">{user.email}</p> : null}
          </div>
        </div>
      ) : null}

      <div className="menu-list">
        <button type="button" className="menu-item" onClick={() => onShow('notifications')}>
          <Bell aria-hidden="true" strokeWidth={1.5} />
          <span className="menu-item__label">Notifications</span>
          {unread > 0 ? (
            <span className="menu-item__badge" aria-label={`${unread} unread`}>
              {formatCount(unread)}
            </span>
          ) : null}
          <ChevronRight className="menu-item__chevron" aria-hidden="true" strokeWidth={1.5} />
        </button>
        <button type="button" className="menu-item" onClick={() => onShow('account')}>
          <Shield aria-hidden="true" strokeWidth={1.5} />
          <span className="menu-item__label">Account and privacy</span>
          <ChevronRight className="menu-item__chevron" aria-hidden="true" strokeWidth={1.5} />
        </button>
        <Link className="menu-item" to="/feedback">
          <MessageSquare aria-hidden="true" strokeWidth={1.5} />
          <span className="menu-item__label">Send feedback</span>
          <ChevronRight className="menu-item__chevron" aria-hidden="true" strokeWidth={1.5} />
        </Link>
      </div>

      <div className="menu-theme">
        <span>Appearance</span>
        <ThemeToggle variant="compact" />
      </div>

      <button type="button" className="button menu-logout" onClick={onSignOut}>
        <LogOut aria-hidden="true" strokeWidth={1.5} />
        Log out
      </button>
    </div>
  );
}
