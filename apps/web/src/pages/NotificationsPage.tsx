import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, BellRing } from 'lucide-react';
import { Link } from 'react-router-dom';

import { ErrorNotice } from '@web/components/app/ErrorNotice';
import { EmptyState, LoadingState } from '@web/components/app/StateViews';
import { useAuth } from '@web/context/useAuth';
import { formatRelative } from '@web/lib/format';
import { gmailMessageUrl } from '@web/lib/gmailLink';
import {
  currentSubscription,
  pushAvailability,
  subscribeThisBrowser,
  unsubscribeThisBrowser,
  type PushAvailability,
} from '@web/lib/push';
import { useNotificationFeed } from '@web/queries/notifications';
import { queryKeys } from '@web/queries/queryKeys';
import { api } from '@web/services/http';
import { pivotOrderKey } from '@web/types/facets';
import type { NotificationItem } from '@web/types/notifications';

function folderLink(item: NotificationItem): string | null {
  if (!item.folder) return null;
  const params = new URLSearchParams({
    order: pivotOrderKey(item.folder.order),
    folder: item.folder.facetKey,
    range: 'all',
  });
  return `/inbox?${params.toString()}`;
}

/** Why the switch says what it says. Each state names what the person can do about it. */
function PushSwitch() {
  const queryClient = useQueryClient();
  const [availability, setAvailability] = useState<PushAvailability>(pushAvailability);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const configQuery = useQuery({
    queryKey: queryKeys.pushConfig,
    queryFn: () => api.getPushConfig(),
  });

  useEffect(() => {
    let cancelled = false;
    void currentSubscription()
      .then((subscription) => {
        if (!cancelled) setSubscribed(Boolean(subscription));
      })
      .catch(() => {
        if (!cancelled) setSubscribed(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const turnOn = useMutation({
    mutationFn: async () => {
      const publicKey = configQuery.data?.publicKey;
      if (!publicKey) throw new Error('This server is not set up to send notifications.');
      try {
        const subscription = await subscribeThisBrowser(publicKey);
        await api.subscribePush(subscription);
      } finally {
        setAvailability(pushAvailability());
      }
    },
    onSuccess: () => {
      setSubscribed(true);
      void queryClient.invalidateQueries({ queryKey: queryKeys.pushConfig });
    },
  });

  const turnOff = useMutation({
    mutationFn: async () => {
      const endpoint = await unsubscribeThisBrowser();
      if (endpoint) await api.unsubscribePush(endpoint);
    },
    onSuccess: () => {
      setSubscribed(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.pushConfig });
    },
  });

  let state: { title: string; detail: string; action: 'on' | 'off' | null };
  if (availability === 'unsupported') {
    state = {
      title: 'Not available in this browser',
      detail:
        'This browser cannot show notifications from websites. Chrome or Edge on Windows can, and so can AMO installed as an app.',
      action: null,
    };
  } else if (configQuery.data && !configQuery.data.configured) {
    state = {
      title: 'Not switched on for this server yet',
      detail:
        'New mail still appears here and as a pop-up while AMO is open. Device notifications need the server to be given its notification keys.',
      action: null,
    };
  } else if (availability === 'denied') {
    state = {
      title: 'Blocked in this browser',
      detail:
        'You chose not to allow notifications. To change that, open this site’s settings from the padlock in the address bar, allow notifications, then come back here.',
      action: null,
    };
  } else if (subscribed) {
    state = {
      title: 'On for this device',
      detail:
        'New mail shows up in your Windows notification centre — or your phone’s — even with AMO closed.',
      action: 'off',
    };
  } else {
    state = {
      title: 'Off for this device',
      detail:
        'Turn them on to see new mail in your Windows notification centre, even with AMO closed. Your browser will ask first.',
      action: 'on',
    };
  }

  const busy =
    turnOn.isPending || turnOff.isPending || configQuery.isPending || subscribed === null;
  const failure = turnOn.error ?? turnOff.error;

  return (
    <section className="push-switch" aria-label="Device notifications">
      <div className="push-switch__icon" aria-hidden="true">
        {subscribed ? <BellRing strokeWidth={1.5} /> : <BellOff strokeWidth={1.5} />}
      </div>
      <div className="push-switch__body">
        <p className="push-switch__title">{state.title}</p>
        <p className="push-switch__detail">{state.detail}</p>
        {failure ? (
          <p className="push-switch__error" role="alert">
            {failure instanceof Error && failure.message === 'PERMISSION_DENIED'
              ? 'Notifications were not allowed, so nothing was turned on.'
              : 'Notifications could not be changed. Please try again.'}
          </p>
        ) : null}
      </div>
      {state.action === 'on' ? (
        <button
          type="button"
          className="button button--primary"
          disabled={busy}
          onClick={() => turnOn.mutate()}
        >
          {turnOn.isPending ? 'Turning on…' : 'Turn on'}
        </button>
      ) : null}
      {state.action === 'off' ? (
        <button type="button" className="button" disabled={busy} onClick={() => turnOff.mutate()}>
          {turnOff.isPending ? 'Turning off…' : 'Turn off'}
        </button>
      ) : null}
    </section>
  );
}

export function NotificationsPage() {
  const queryClient = useQueryClient();
  const { gmailConnection } = useAuth();
  const feed = useNotificationFeed();

  const markRead = useMutation({
    mutationFn: (ids?: string[]) => api.markNotificationsRead(ids),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.notifications }),
  });

  const items = feed.data?.items ?? [];
  const unread = feed.data?.unreadCount ?? 0;

  return (
    <section className="screen">
      <header className="screen__head">
        <h1 className="screen__title">Notifications</h1>
        {unread > 0 ? (
          <button
            type="button"
            className="button button--quiet"
            disabled={markRead.isPending}
            onClick={() => markRead.mutate(undefined)}
          >
            Mark all as read
          </button>
        ) : null}
      </header>

      <PushSwitch />

      {feed.isPending ? <LoadingState label="Loading notifications" /> : null}
      {feed.isError ? (
        <ErrorNotice
          error={feed.error}
          title="Notifications could not be loaded"
          onRetry={() => void feed.refetch()}
        />
      ) : null}
      {feed.isSuccess && items.length === 0 ? (
        <EmptyState
          title="Nothing new yet"
          description="When new mail arrives, it is listed here within a minute or two."
        />
      ) : null}

      {items.length > 0 ? (
        <ul className="notification-list">
          {items.map((item) => {
            const folder = folderLink(item);
            const sender = item.message.senderName || item.message.senderEmail || 'Someone';
            return (
              <li
                key={item.id}
                className={`notification${item.readAt ? '' : ' notification--unread'}`}
              >
                <div className="notification__head">
                  {item.readAt ? null : <span className="notification__dot" aria-label="Unread" />}
                  <span className="notification__sender">{sender}</span>
                  <time className="notification__time" dateTime={item.createdAt}>
                    {formatRelative(item.message.receivedAt ?? item.createdAt)}
                  </time>
                </div>
                <p className="notification__subject">{item.message.subject}</p>
                {item.folder ? <p className="notification__folder">{item.folder.path}</p> : null}
                <div className="notification__actions">
                  <a
                    className="button button--quiet"
                    href={gmailMessageUrl(
                      gmailConnection?.email ?? null,
                      item.message.gmailMessageId,
                    )}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => {
                      if (!item.readAt) markRead.mutate([item.id]);
                    }}
                  >
                    Open in Gmail
                  </a>
                  {folder ? (
                    <Link
                      className="button button--quiet"
                      to={folder}
                      onClick={() => {
                        if (!item.readAt) markRead.mutate([item.id]);
                      }}
                    >
                      Show folder
                    </Link>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
