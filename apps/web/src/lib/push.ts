/**
 * Turning operating-system notifications on and off for this browser.
 *
 * The browser does the hard part: `Notification.requestPermission` asks the person, and
 * `pushManager.subscribe` registers this browser with its push service — Google's for Chrome,
 * Microsoft's for Edge — and hands back an endpoint plus the keys a payload is encrypted to. The
 * API stores that, and from then on new mail reaches the Windows notification centre (or a phone's)
 * through the service worker in `public/push-handler.js`, with MailMind closed.
 */

export type PushAvailability = 'unsupported' | 'denied' | 'default' | 'granted';

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** Where the browser's permission stands, without asking. */
export function pushAvailability(): PushAvailability {
  if (!pushSupported()) return 'unsupported';
  return Notification.permission;
}

/** The VAPID public key arrives base64url-encoded; the push manager wants raw bytes. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const binary = window.atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * The service worker, once it is running. It is registered by the PWA plugin in production builds
 * only, so in development this gives up rather than waiting forever.
 */
async function registration(timeoutMs = 10_000): Promise<ServiceWorkerRegistration> {
  const timeout = new Promise<never>((_, reject) =>
    window.setTimeout(() => reject(new Error('NO_SERVICE_WORKER')), timeoutMs),
  );
  return Promise.race([navigator.serviceWorker.ready, timeout]);
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const existing = await navigator.serviceWorker.getRegistration();
  return existing ? existing.pushManager.getSubscription() : null;
}

/**
 * Asks for permission if needed and subscribes this browser. Throws `PERMISSION_DENIED` when the
 * person said no — which the browser remembers, so the screen has to explain how to undo it.
 */
export async function subscribeThisBrowser(publicKey: string): Promise<PushSubscriptionJSON> {
  if (!pushSupported()) throw new Error('UNSUPPORTED');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('PERMISSION_DENIED');
  const worker = await registration();
  const applicationServerKey = base64UrlToBytes(publicKey);
  let subscription = await worker.pushManager.getSubscription();
  try {
    subscription ??= await worker.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
  } catch {
    // A subscription made with an older server key blocks a new one; replace it once.
    await subscription?.unsubscribe();
    subscription = await worker.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
  }
  return subscription.toJSON();
}

/** Unsubscribes this browser and returns the endpoint the server should forget, if there was one. */
export async function unsubscribeThisBrowser(): Promise<string | null> {
  const subscription = await currentSubscription();
  if (!subscription) return null;
  const { endpoint } = subscription;
  await subscription.unsubscribe();
  return endpoint;
}
