/*
 * New-mail push handling, imported into the generated service worker (workbox `importScripts`).
 *
 * A push arrives encrypted from the browser's push service, and this is the code that turns it into
 * a notification in the operating system's notification centre — the Windows Action Center for
 * Chrome and Edge on Windows. It runs with MailMind closed; that is the point of it.
 *
 * When a MailMind window is open and focused, no system notification is shown: every open window is
 * told instead, refreshes its feed, and shows the message in the app. A notification for an app you
 * are looking at is a duplicate.
 */

function safeAppUrl(path) {
  try {
    const url = new URL(path || '/notifications', self.location.origin);
    // Only ever open a page of this app, whatever the payload says.
    return url.origin === self.location.origin ? url.href : `${self.location.origin}/notifications`;
  } catch {
    return `${self.location.origin}/notifications`;
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'New email';
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    tag: typeof data.tag === 'string' ? data.tag : 'mailmind-new-mail',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: safeAppUrl(data.url) },
  };

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        client.postMessage({ type: 'mailmind:new-mail', title, body: options.body });
      }
      const watching = windows.some(
        (client) => client.focused && client.visibilityState === 'visible',
      );
      if (watching) return;
      await self.registration.showNotification(title, options);
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = safeAppUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find(
        (client) => new URL(client.url).origin === self.location.origin,
      );
      if (existing) {
        await existing.focus();
        if ('navigate' in existing) await existing.navigate(target);
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
