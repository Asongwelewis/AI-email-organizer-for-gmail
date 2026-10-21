import { useQuery } from '@tanstack/react-query';

import { useAuth } from '@web/context/useAuth';

import { api } from '@web/services/http';
import { queryKeys } from './queryKeys';

/** How often an open app looks for new-mail notifications. The watcher checks Gmail as often. */
export const NOTIFICATION_POLL_MS = 60_000;

/**
 * The new-mail feed. One query for the whole app: the menu badge, the notifications screen and the
 * toasts all read the same cache, so they can never disagree about what is unread.
 */
export function useNotificationFeed(enabled = true) {
  // The feed belongs to a mailbox. Asked before one is connected it can only answer 409.
  const { gmailConnection } = useAuth();
  return useQuery({
    queryKey: queryKeys.notifications,
    queryFn: () => api.getNotifications(),
    enabled: enabled && gmailConnection?.connected === true,
    refetchInterval: NOTIFICATION_POLL_MS,
  });
}
