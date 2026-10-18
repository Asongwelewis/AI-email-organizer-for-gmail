import { useQuery } from '@tanstack/react-query';

import { api } from '@web/services/http';
import { queryKeys } from './queryKeys';

/** How often an open app looks for new-mail notifications. The watcher checks Gmail as often. */
export const NOTIFICATION_POLL_MS = 60_000;

/**
 * The new-mail feed. One query for the whole app: the menu badge, the notifications screen and the
 * toasts all read the same cache, so they can never disagree about what is unread.
 */
export function useNotificationFeed(enabled = true) {
  return useQuery({
    queryKey: queryKeys.notifications,
    queryFn: () => api.getNotifications(),
    enabled,
    refetchInterval: NOTIFICATION_POLL_MS,
  });
}
