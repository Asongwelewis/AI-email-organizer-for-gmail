import { Menu } from 'lucide-react';

import { ISLAND_WINDOW_ID } from '@web/components/app/islandWindowState';
import { formatCount } from '@web/lib/format';
import { useNotificationFeed } from '@web/queries/notifications';

/** The unread count on a menu control, or nothing. Hidden from screen readers: the label says it. */
export function UnreadBadge() {
  const feed = useNotificationFeed();
  const unread = feed.data?.unreadCount ?? 0;
  if (unread === 0) return null;
  return (
    <span className="menu-button__badge" aria-hidden="true">
      {unread > 99 ? '99+' : formatCount(unread)}
    </span>
  );
}

function useMenuLabel(): string {
  const feed = useNotificationFeed();
  const unread = feed.data?.unreadCount ?? 0;
  return unread > 0 ? `Menu, ${unread} unread notifications` : 'Menu';
}

/**
 * Opens the island's window — on a phone, and on the desktop app's island. It carries the unread
 * count, so new mail is visible from every screen without spending a sixth tab on notifications.
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
  const label = useMenuLabel();
  return (
    <button
      type="button"
      className={className}
      data-island-trigger
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-controls={expanded ? ISLAND_WINDOW_ID : undefined}
      aria-label={label}
      title="Menu"
      onClick={onToggle}
    >
      <Menu aria-hidden="true" strokeWidth={1.75} />
      <UnreadBadge />
    </button>
  );
}
