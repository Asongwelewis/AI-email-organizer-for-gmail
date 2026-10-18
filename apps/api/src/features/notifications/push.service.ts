import webpush from 'web-push';

import { env } from '@api/config/env.js';
import { logger } from '@api/config/logger.js';
import { prisma } from '@api/database/prisma.js';

/**
 * Delivers notifications to the operating system through Web Push.
 *
 * The browser subscribes with its push service — Google's for Chrome, Microsoft's for Edge,
 * Mozilla's for Firefox — and that is how a new-mail notification reaches the Windows notification
 * centre, or a phone's, with MailMind closed. The payload is encrypted to keys only that browser
 * holds (RFC 8291), so the push service carries it without being able to read it.
 *
 * Optional by configuration: without VAPID keys nothing is sent and notifications stay inside the
 * app, which is still a complete feature.
 */

export interface PushPayload {
  title: string;
  body: string;
  /** Where a click opens. Always a path inside the app. */
  url: string;
  /** Same tag, same slot: a newer notification replaces the older one rather than stacking. */
  tag: string;
}

/** Failures in a row before a subscription is treated as abandoned and dropped. */
const MAX_FAILURES = 10;

let configured = false;

/**
 * Who a push service can contact about our pushes. The spec allows only `https:` or `mailto:`, and
 * web-push refuses anything else, so an `http:` WEB_APP_URL — every local setup — is no subject.
 */
function vapidSubject(): string | null {
  const candidate = env.WEB_PUSH_SUBJECT ?? env.WEB_APP_URL;
  return /^(https:|mailto:)/i.test(candidate) ? candidate : null;
}

export function isPushConfigured(): boolean {
  return Boolean(env.WEB_PUSH_VAPID_PUBLIC_KEY && env.WEB_PUSH_VAPID_PRIVATE_KEY && vapidSubject());
}

export function pushPublicKey(): string | null {
  return isPushConfigured() ? env.WEB_PUSH_VAPID_PUBLIC_KEY! : null;
}

function configure(): void {
  if (configured || !isPushConfigured()) return;
  webpush.setVapidDetails(
    vapidSubject()!,
    env.WEB_PUSH_VAPID_PUBLIC_KEY!,
    env.WEB_PUSH_VAPID_PRIVATE_KEY!,
  );
  configured = true;
}

type Sender = (
  subscription: webpush.PushSubscription,
  payload: string,
  options: webpush.RequestOptions,
) => Promise<unknown>;

export class PushService {
  constructor(
    private readonly sender: Sender = (subscription, payload, options) =>
      webpush.sendNotification(subscription, payload, options),
  ) {}

  /**
   * Sends one payload to every browser a person has subscribed. Returns how many accepted it.
   *
   * A 404 or 410 means the browser unsubscribed or the subscription expired, so the row goes. Any
   * other failure is counted, and a subscription that has failed many times in a row is dropped
   * too: a dead endpoint would otherwise be retried on every new message forever.
   */
  async sendToUser(userId: string, payload: PushPayload): Promise<number> {
    if (!isPushConfigured()) return 0;
    configure();
    const subscriptions = await prisma.push_subscriptions.findMany({ where: { user_id: userId } });
    let delivered = 0;
    for (const subscription of subscriptions) {
      try {
        await this.sender(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          JSON.stringify(payload),
          // An hour: mail that waited longer than that to be announced is not news any more.
          { TTL: 60 * 60, urgency: 'normal' },
        );
        delivered += 1;
        await prisma.push_subscriptions.update({
          where: { id: subscription.id },
          data: { last_success_at: new Date(), failure_count: 0 },
        });
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410 || subscription.failure_count + 1 >= MAX_FAILURES) {
          await prisma.push_subscriptions.deleteMany({ where: { id: subscription.id } });
        } else {
          await prisma.push_subscriptions.update({
            where: { id: subscription.id },
            data: { failure_count: { increment: 1 } },
          });
        }
        logger.warn({ status: status ?? null }, 'push delivery failed');
      }
    }
    return delivered;
  }
}

export const pushService = new PushService();
