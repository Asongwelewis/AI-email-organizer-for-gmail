import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { useNotificationFeed } from '@web/queries/notifications';
import { queryKeys } from '@web/queries/queryKeys';
import type { NotificationItem } from '@web/types/notifications';

/** More than this many at once is one toast, not a stack of them. */
const MAX_INDIVIDUAL_TOASTS = 3;

function senderOf(item: NotificationItem): string {
  return item.message.senderName || item.message.senderEmail || 'Someone';
}

/**
 * New mail, announced inside the app while it is open.
 *
 * Renders nothing. It watches the one notification feed the whole app shares and shows a toast for
 * anything that arrived since it last looked — never for what was already there when the app
 * opened, which would greet every launch with a pile of old news. A push that arrives while the app
 * is focused does not become a system notification (see `public/push-handler.js`); the service
 * worker tells this component instead, and the feed is refreshed at once rather than at the next
 * minute.
 *
 * It also keeps the installed app's taskbar badge — the number on the MailMind icon in Windows —
 * in step with what is unread.
 */
export function NotificationCenter() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const feed = useNotificationFeed();
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    const items = feed.data?.items;
    if (!items) return;
    if (!seen.current) {
      seen.current = new Set(items.map((item) => item.id));
      return;
    }
    const known = seen.current;
    const fresh = items.filter((item) => !known.has(item.id) && !item.readAt);
    for (const item of items) known.add(item.id);
    if (fresh.length === 0) return;

    const view = { label: 'View', onClick: () => navigate('/notifications') };
    if (fresh.length > MAX_INDIVIDUAL_TOASTS) {
      const senders = [...new Set(fresh.map(senderOf))].slice(0, 3).join(', ');
      toast(`${fresh.length} new emails`, { description: `From ${senders}`, action: view });
      return;
    }
    for (const item of fresh) {
      toast(senderOf(item), { description: item.message.subject, action: view });
    }
  }, [feed.data, navigate]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string } | null;
      if (data?.type === 'mailmind:new-mail') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [queryClient]);

  const unread = feed.data?.unreadCount;
  useEffect(() => {
    if (unread === undefined || typeof navigator === 'undefined') return;
    // Only installed apps have a badge to set; everywhere else these do not exist.
    const badge = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (unread > 0) void badge.setAppBadge?.(unread).catch(() => undefined);
    else void badge.clearAppBadge?.().catch(() => undefined);
  }, [unread]);

  return null;
}
