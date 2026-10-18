import { Bell, ChevronRight, History, LogOut, MessageSquare, Shield } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Avatar } from '@web/components/Avatar';
import { ThemeToggle } from '@web/components/ThemeToggle';
import { useAuth } from '@web/context/useAuth';
import { formatCount } from '@web/lib/format';
import { useNotificationFeed } from '@web/queries/notifications';

/**
 * Everything that is not one of the five everyday screens.
 *
 * The tab bar holds what is opened every day — Inbox, Find, Favourites, Folders, Activity. The rest
 * lives here, behind the menu icon on the left of every screen, starting with notifications.
 */
export function MenuPage() {
  const { user, logout } = useAuth();
  const feed = useNotificationFeed();
  const unread = feed.data?.unreadCount ?? 0;

  return (
    <section className="screen">
      <header className="screen__head">
        <h1 className="screen__title">Menu</h1>
      </header>

      {user ? (
        <div className="menu-profile">
          <Avatar name={user.displayName} email={user.email} src={user.avatarUrl} />
          <div>
            <p className="menu-profile__name">{user.displayName ?? user.email}</p>
            {user.displayName ? <p className="menu-profile__email">{user.email}</p> : null}
          </div>
        </div>
      ) : null}

      <nav className="menu-list" aria-label="Menu">
        <Link className="menu-item" to="/notifications">
          <Bell aria-hidden="true" strokeWidth={1.5} />
          <span className="menu-item__label">Notifications</span>
          {unread > 0 ? (
            <span className="menu-item__badge" aria-label={`${unread} unread`}>
              {formatCount(unread)}
            </span>
          ) : null}
          <ChevronRight className="menu-item__chevron" aria-hidden="true" strokeWidth={1.5} />
        </Link>
        <Link className="menu-item" to="/activity">
          <History aria-hidden="true" strokeWidth={1.5} />
          <span className="menu-item__label">Activity</span>
          <ChevronRight className="menu-item__chevron" aria-hidden="true" strokeWidth={1.5} />
        </Link>
        <Link className="menu-item" to="/account">
          <Shield aria-hidden="true" strokeWidth={1.5} />
          <span className="menu-item__label">Account and privacy</span>
          <ChevronRight className="menu-item__chevron" aria-hidden="true" strokeWidth={1.5} />
        </Link>
        <Link className="menu-item" to="/feedback">
          <MessageSquare aria-hidden="true" strokeWidth={1.5} />
          <span className="menu-item__label">Send feedback</span>
          <ChevronRight className="menu-item__chevron" aria-hidden="true" strokeWidth={1.5} />
        </Link>
      </nav>

      <div className="menu-theme">
        <span>Appearance</span>
        <ThemeToggle variant="compact" />
      </div>

      <button type="button" className="button menu-logout" onClick={() => void logout()}>
        <LogOut aria-hidden="true" strokeWidth={1.5} />
        Log out
      </button>
    </section>
  );
}
