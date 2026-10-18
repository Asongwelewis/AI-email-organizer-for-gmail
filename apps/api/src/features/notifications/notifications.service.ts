import { prisma } from '@api/database/prisma.js';
import { AppError } from '@api/errors/AppError.js';
import {
  activityRepository,
  type ActivityRepository,
} from '@api/features/activity/activity.repository.js';
import {
  DEFAULT_PIVOT,
  PIVOT_FACETS,
  pivotLeafName,
  type PivotFacet,
} from '@api/features/label-discovery/pivot.js';
import { pushService, type PushPayload, type PushService } from './push.service.js';

/**
 * New-mail notifications: the feed inside the app, and the push that carries them to the OS.
 *
 * The watcher calls `recordNewMail` after every check. It does not trust that check to know what
 * is new — a full run or a manual sync can store mail too — so it asks the database instead: unread
 * inbox mail that arrived recently, was stored recently, and has never been announced. The unique
 * message id on `notifications` is what makes "never been announced" hold across ticks, restarts
 * and instances.
 */

/** How recent a message must be, by arrival and by storage, to be announced at all. */
const RECENT_MS = 2 * 60 * 60 * 1000;
/** Most messages announced per check; a backlog is not news. */
const MAX_PER_CHECK = 20;
/** More than this many at once becomes one summary push instead of one per message. */
const MAX_INDIVIDUAL_PUSHES = 3;

export interface NotificationItem {
  id: string;
  kind: 'NEW_MAIL';
  createdAt: string;
  readAt: string | null;
  message: {
    gmailMessageId: string;
    subject: string;
    senderName: string | null;
    senderEmail: string | null;
    snippet: string | null;
    receivedAt: string | null;
  };
  /** The folder it was sorted into, in the saved arrangement, once it has been sorted. */
  folder: { facetKey: string; path: string; order: PivotFacet[] } | null;
}

function sender(name: string | null, email: string | null): string {
  return name?.trim() || email?.trim() || 'Someone';
}

function folderOf(
  facets: { entity: string | null; domain: string | null; intent: string | null } | null,
  order: PivotFacet[],
): NotificationItem['folder'] {
  if (!facets) return null;
  const keyParts: string[] = [];
  const names: string[] = [];
  for (const facet of order) {
    const value = facets[facet];
    const name = value ? pivotLeafName(value, facet) : null;
    if (!value || !name) break;
    keyParts.push(`${facet}=${value}`);
    names.push(name);
  }
  return keyParts.length > 0
    ? { facetKey: keyParts.join('|'), path: names.join(' › '), order }
    : null;
}

export class NotificationsService {
  constructor(
    private readonly push: Pick<PushService, 'sendToUser'> = pushService,
    private readonly accounts: ActivityRepository = activityRepository,
  ) {}

  /** Announces mail that arrived since the last check. Returns how many were announced. */
  async recordNewMail(accountId: string, now = Date.now()): Promise<number> {
    const since = new Date(now - RECENT_MS);
    const candidates = await prisma.gmail_message_metadata.findMany({
      where: {
        connected_google_account_id: accountId,
        deleted_at: null,
        is_unread: true,
        is_sent: false,
        is_draft: false,
        is_trashed: false,
        label_ids: { has: 'INBOX' },
        NOT: { label_ids: { hasSome: ['SPAM', 'TRASH'] } },
        internal_date: { gte: since },
        created_at: { gte: since },
        notification: null,
      },
      orderBy: { internal_date: 'asc' },
      take: MAX_PER_CHECK,
      select: { id: true, subject: true, sender_name: true, sender_email: true },
    });
    if (candidates.length === 0) return 0;

    // Only the rows this call actually created are announced, so two instances racing over the
    // same new message push it once.
    const created = await prisma.notifications.createManyAndReturn({
      data: candidates.map((message) => ({
        connected_google_account_id: accountId,
        gmail_message_id: message.id,
      })),
      skipDuplicates: true,
      select: { id: true, gmail_message_id: true },
    });
    if (created.length === 0) return 0;

    const account = await prisma.connected_google_accounts.findUnique({
      where: { id: accountId },
      select: { user_id: true },
    });
    if (account) {
      const announced = new Set(created.map((row) => row.gmail_message_id));
      const fresh = candidates.filter((message) => announced.has(message.id));
      for (const payload of this.payloads(fresh, created)) {
        await this.push.sendToUser(account.user_id, payload);
      }
    }
    return created.length;
  }

  private payloads(
    messages: Array<{
      id: string;
      subject: string | null;
      sender_name: string | null;
      sender_email: string | null;
    }>,
    created: Array<{ id: string; gmail_message_id: string }>,
  ): PushPayload[] {
    if (messages.length > MAX_INDIVIDUAL_PUSHES) {
      const senders = [...new Set(messages.map((m) => sender(m.sender_name, m.sender_email)))];
      const named = senders.slice(0, 3).join(', ');
      return [
        {
          title: `${messages.length} new emails`,
          body: senders.length > 3 ? `From ${named} and others` : `From ${named}`,
          url: '/notifications',
          tag: 'mailmind-new-mail',
        },
      ];
    }
    const notificationIdFor = new Map(created.map((row) => [row.gmail_message_id, row.id]));
    return messages.map((message) => ({
      title: sender(message.sender_name, message.sender_email),
      body: message.subject?.trim() || '(no subject)',
      url: '/notifications',
      tag: notificationIdFor.get(message.id) ?? message.id,
    }));
  }

  async list(
    userId: string,
    options: { limit?: number | undefined; cursor?: string | undefined } = {},
  ): Promise<{ items: NotificationItem[]; unreadCount: number; nextCursor: string | null }> {
    const account = await this.accounts.activeAccountForUser(userId);
    const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
    const cursor = options.cursor ? new Date(options.cursor) : null;
    if (cursor && Number.isNaN(cursor.getTime())) {
      throw new AppError('NOTIFICATION_VALIDATION_FAILED', 'That cursor is not a date.', 400);
    }
    const [rows, unreadCount, settings] = await Promise.all([
      prisma.notifications.findMany({
        where: {
          connected_google_account_id: account.id,
          ...(cursor ? { created_at: { lt: cursor } } : {}),
        },
        orderBy: { created_at: 'desc' },
        take: limit + 1,
        include: {
          message: {
            select: {
              gmail_message_id: true,
              subject: true,
              sender_name: true,
              sender_email: true,
              snippet: true,
              internal_date: true,
              facets: { select: { entity: true, domain: true, intent: true } },
            },
          },
        },
      }),
      prisma.notifications.count({
        where: { connected_google_account_id: account.id, read_at: null },
      }),
      prisma.facet_pivot_settings.findUnique({
        where: { connected_google_account_id: account.id },
        select: { canonical_pivot: true },
      }),
    ]);
    const saved = (settings?.canonical_pivot ?? []).filter((facet): facet is PivotFacet =>
      (PIVOT_FACETS as readonly string[]).includes(facet),
    );
    const order = saved.length > 0 ? saved : DEFAULT_PIVOT;
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => ({
        id: row.id,
        kind: row.kind,
        createdAt: row.created_at.toISOString(),
        readAt: row.read_at?.toISOString() ?? null,
        message: {
          gmailMessageId: row.message.gmail_message_id,
          subject: row.message.subject?.trim() || '(no subject)',
          senderName: row.message.sender_name,
          senderEmail: row.message.sender_email,
          snippet: row.message.snippet,
          receivedAt: row.message.internal_date?.toISOString() ?? null,
        },
        folder: folderOf(row.message.facets, order),
      })),
      unreadCount,
      nextCursor: rows.length > limit ? page.at(-1)!.created_at.toISOString() : null,
    };
  }

  /** Marks the given notifications read, or every one when no ids are given. */
  async markRead(userId: string, ids?: string[]): Promise<number> {
    const account = await this.accounts.activeAccountForUser(userId);
    const result = await prisma.notifications.updateMany({
      where: {
        connected_google_account_id: account.id,
        read_at: null,
        ...(ids ? { id: { in: ids } } : {}),
      },
      data: { read_at: new Date() },
    });
    return result.count;
  }

  /** One row per browser. Subscribing again from the same browser refreshes its keys. */
  async subscribe(
    userId: string,
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    userAgent: string | null,
  ): Promise<void> {
    const data = {
      user_id: userId,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      user_agent: userAgent?.slice(0, 300) ?? null,
      failure_count: 0,
    };
    await prisma.push_subscriptions.upsert({
      where: { endpoint: subscription.endpoint },
      create: { endpoint: subscription.endpoint, ...data },
      update: data,
    });
  }

  /** Only ever removes the caller's own subscription, whatever endpoint is sent. */
  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    await prisma.push_subscriptions.deleteMany({ where: { user_id: userId, endpoint } });
  }

  async subscriptionCount(userId: string): Promise<number> {
    return prisma.push_subscriptions.count({ where: { user_id: userId } });
  }
}

export const notificationsService = new NotificationsService();
