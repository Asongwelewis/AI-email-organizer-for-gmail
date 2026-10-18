import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  messageFindMany: vi.fn(),
  createManyAndReturn: vi.fn(),
  notificationFindMany: vi.fn(),
  notificationCount: vi.fn(),
  notificationUpdateMany: vi.fn(),
  accountFindUnique: vi.fn(),
  settingsFindUnique: vi.fn(),
  subscriptionFindMany: vi.fn(),
  subscriptionUpsert: vi.fn(),
  subscriptionDeleteMany: vi.fn(),
  subscriptionUpdate: vi.fn(),
  subscriptionCount: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../src/config/logger.js', () => ({
  logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn() },
  safeErrorDetails: () => ({}),
}));
vi.mock('../src/sessions/session.service.js', () => ({
  sessionService: {
    authenticate: mocks.authenticate,
    authenticateAndRenew: async (request: unknown) => ({
      session: await mocks.authenticate(request),
      renewedToken: null,
    }),
  },
}));
vi.mock('../src/database/prisma.js', () => ({
  prisma: {
    gmail_message_metadata: { findMany: mocks.messageFindMany },
    notifications: {
      createManyAndReturn: mocks.createManyAndReturn,
      findMany: mocks.notificationFindMany,
      count: mocks.notificationCount,
      updateMany: mocks.notificationUpdateMany,
    },
    connected_google_accounts: {
      findUnique: mocks.accountFindUnique,
      findFirst: async () => ({ id: 'account-1', user_id: 'user-1' }),
    },
    facet_pivot_settings: { findUnique: mocks.settingsFindUnique },
    push_subscriptions: {
      findMany: mocks.subscriptionFindMany,
      upsert: mocks.subscriptionUpsert,
      deleteMany: mocks.subscriptionDeleteMany,
      update: mocks.subscriptionUpdate,
      count: mocks.subscriptionCount,
    },
  },
}));

const { env } = await import('../src/config/env.js');
const { NotificationsService } =
  await import('../src/features/notifications/notifications.service.js');
const { PushService } = await import('../src/features/notifications/push.service.js');
const { notificationsRouter } =
  await import('../src/features/notifications/notifications.routes.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');

const NOW = new Date('2026-10-18T12:00:00.000Z').getTime();

const message = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  subject: `Subject ${id}`,
  sender_name: `Sender ${id}`,
  sender_email: `${id}@example.com`,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accountFindUnique.mockResolvedValue({ user_id: 'user-1' });
});

/*
 * What decides that someone gets a notification. It asks the database rather than trusting one
 * check to know what is new, so mail stored by a full run is announced too — and the unique message
 * id is what makes "announced once" hold across ticks and instances.
 */
describe('announcing new mail', () => {
  const service = () => {
    const push = { sendToUser: vi.fn().mockResolvedValue(1) };
    return { push, notifications: new NotificationsService(push) };
  };

  it('asks only for recent, unread inbox mail that was never announced', async () => {
    mocks.messageFindMany.mockResolvedValue([]);
    const { notifications } = service();

    await expect(notifications.recordNewMail('account-1', NOW)).resolves.toBe(0);

    const where = mocks.messageFindMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({
      connected_google_account_id: 'account-1',
      is_unread: true,
      is_sent: false,
      label_ids: { has: 'INBOX' },
      notification: null,
    });
    expect(NOW - where.internal_date.gte.getTime()).toBe(2 * 60 * 60 * 1000);
    expect(mocks.createManyAndReturn).not.toHaveBeenCalled();
  });

  it('pushes each of a few new messages by sender and subject', async () => {
    mocks.messageFindMany.mockResolvedValue([message('a'), message('b')]);
    mocks.createManyAndReturn.mockResolvedValue([
      { id: 'n-a', gmail_message_id: 'a' },
      { id: 'n-b', gmail_message_id: 'b' },
    ]);
    const { push, notifications } = service();

    await expect(notifications.recordNewMail('account-1', NOW)).resolves.toBe(2);

    expect(push.sendToUser).toHaveBeenCalledTimes(2);
    expect(push.sendToUser).toHaveBeenCalledWith('user-1', {
      title: 'Sender a',
      body: 'Subject a',
      url: '/notifications',
      tag: 'n-a',
    });
  });

  it('sums a burst up in one push rather than one per message', async () => {
    const burst = ['a', 'b', 'c', 'd', 'e'].map((id) => message(id));
    mocks.messageFindMany.mockResolvedValue(burst);
    mocks.createManyAndReturn.mockResolvedValue(
      burst.map((entry) => ({ id: `n-${entry.id}`, gmail_message_id: entry.id })),
    );
    const { push, notifications } = service();

    await notifications.recordNewMail('account-1', NOW);

    expect(push.sendToUser).toHaveBeenCalledTimes(1);
    expect(push.sendToUser.mock.calls[0]![1]).toMatchObject({
      title: '5 new emails',
      body: 'From Sender a, Sender b, Sender c and others',
    });
  });

  // Two instances racing over one message: only the one whose insert landed pushes it.
  it('pushes only what this call actually recorded', async () => {
    mocks.messageFindMany.mockResolvedValue([message('a'), message('b')]);
    mocks.createManyAndReturn.mockResolvedValue([{ id: 'n-b', gmail_message_id: 'b' }]);
    const { push, notifications } = service();

    await expect(notifications.recordNewMail('account-1', NOW)).resolves.toBe(1);

    expect(push.sendToUser).toHaveBeenCalledTimes(1);
    expect(push.sendToUser.mock.calls[0]![1]).toMatchObject({ title: 'Sender b' });
  });
});

describe('the notification feed', () => {
  it('names the folder each message was sorted into, in the saved arrangement', async () => {
    mocks.notificationFindMany.mockResolvedValue([
      {
        id: 'n-1',
        kind: 'NEW_MAIL',
        created_at: new Date('2026-10-18T11:00:00.000Z'),
        read_at: null,
        message: {
          gmail_message_id: '18f0abc',
          subject: 'Your payment failed',
          sender_name: 'Netflix',
          sender_email: 'info@netflix.com',
          snippet: 'Update your card',
          internal_date: new Date('2026-10-18T10:59:00.000Z'),
          facets: { entity: 'netflix', domain: 'entertainment', intent: 'payment-failed' },
        },
      },
    ]);
    mocks.notificationCount.mockResolvedValue(1);
    mocks.settingsFindUnique.mockResolvedValue({ canonical_pivot: ['entity', 'intent'] });

    const feed = await new NotificationsService().list('user-1');

    expect(feed.unreadCount).toBe(1);
    expect(feed.nextCursor).toBeNull();
    expect(feed.items[0]).toMatchObject({
      message: { gmailMessageId: '18f0abc', subject: 'Your payment failed' },
      folder: {
        facetKey: 'entity=netflix|intent=payment-failed',
        path: 'Netflix › Payment failed',
        order: ['entity', 'intent'],
      },
    });
  });

  it('marks only the caller’s own notifications read', async () => {
    mocks.notificationUpdateMany.mockResolvedValue({ count: 3 });

    await expect(new NotificationsService().markRead('user-1')).resolves.toBe(3);

    expect(mocks.notificationUpdateMany.mock.calls[0]![0].where).toEqual({
      connected_google_account_id: 'account-1',
      read_at: null,
    });
  });
});

/*
 * Push delivery has to clean up after itself: a browser that unsubscribed answers 410, and an
 * endpoint that keeps failing would otherwise be retried on every new message forever.
 */
describe('delivering a push', () => {
  const originalPublic = env.WEB_PUSH_VAPID_PUBLIC_KEY;
  const originalPrivate = env.WEB_PUSH_VAPID_PRIVATE_KEY;
  const payload = { title: 'Netflix', body: 'Hi', url: '/notifications', tag: 'n-1' };
  const subscription = (failures = 0) => ({
    id: 'sub-1',
    endpoint: 'https://push.example/abc',
    p256dh: 'p256dh-key-material',
    auth: 'auth-secret',
    failure_count: failures,
  });

  beforeEach(() => {
    // A real key pair shape, so web-push accepts the configuration.
    env.WEB_PUSH_VAPID_PUBLIC_KEY =
      'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
    env.WEB_PUSH_VAPID_PRIVATE_KEY = 'UUxI4O8-FbRouAevSmBQ6o18hgE4nSG3qwvJTfKc-ls';
    env.WEB_PUSH_SUBJECT = 'mailto:push@example.com';
  });

  afterEach(() => {
    env.WEB_PUSH_VAPID_PUBLIC_KEY = originalPublic;
    env.WEB_PUSH_VAPID_PRIVATE_KEY = originalPrivate;
    env.WEB_PUSH_SUBJECT = undefined;
  });

  // The spec allows only https: or mailto:, and every local setup's WEB_APP_URL is http:.
  it('treats push as unconfigured without a subject a push service will accept', async () => {
    env.WEB_PUSH_SUBJECT = undefined;
    const sender = vi.fn();
    await expect(new PushService(sender).sendToUser('user-1', payload)).resolves.toBe(0);
    expect(sender).not.toHaveBeenCalled();
  });

  it('sends nothing at all when push is not configured', async () => {
    env.WEB_PUSH_VAPID_PUBLIC_KEY = undefined;
    env.WEB_PUSH_VAPID_PRIVATE_KEY = undefined;
    const sender = vi.fn();
    await expect(new PushService(sender).sendToUser('user-1', payload)).resolves.toBe(0);
    expect(sender).not.toHaveBeenCalled();
  });

  it('encrypts to the browser keys and records the success', async () => {
    mocks.subscriptionFindMany.mockResolvedValue([subscription()]);
    const sender = vi.fn().mockResolvedValue({ statusCode: 201 });

    await expect(new PushService(sender).sendToUser('user-1', payload)).resolves.toBe(1);

    expect(sender.mock.calls[0]![0]).toEqual({
      endpoint: 'https://push.example/abc',
      keys: { p256dh: 'p256dh-key-material', auth: 'auth-secret' },
    });
    expect(JSON.parse(sender.mock.calls[0]![1])).toEqual(payload);
    expect(mocks.subscriptionUpdate.mock.calls[0]![0].data).toMatchObject({ failure_count: 0 });
  });

  it('forgets a browser that unsubscribed', async () => {
    mocks.subscriptionFindMany.mockResolvedValue([subscription()]);
    const sender = vi.fn().mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 410 }));

    await new PushService(sender).sendToUser('user-1', payload);

    expect(mocks.subscriptionDeleteMany).toHaveBeenCalledWith({ where: { id: 'sub-1' } });
  });

  it('counts a passing failure, and drops an endpoint that never recovers', async () => {
    mocks.subscriptionFindMany.mockResolvedValue([subscription(0)]);
    const sender = vi.fn().mockRejectedValue(Object.assign(new Error('busy'), { statusCode: 503 }));
    await new PushService(sender).sendToUser('user-1', payload);
    expect(mocks.subscriptionUpdate.mock.calls[0]![0].data).toEqual({
      failure_count: { increment: 1 },
    });
    expect(mocks.subscriptionDeleteMany).not.toHaveBeenCalled();

    mocks.subscriptionFindMany.mockResolvedValue([subscription(9)]);
    await new PushService(sender).sendToUser('user-1', payload);
    expect(mocks.subscriptionDeleteMany).toHaveBeenCalledWith({ where: { id: 'sub-1' } });
  });
});

describe('/api/notifications', () => {
  const ORIGIN = 'http://localhost:5173';
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/notifications', notificationsRouter);
  app.use(errorHandler);

  beforeEach(() => {
    mocks.authenticate.mockResolvedValue({
      id: 'session-id',
      user: { id: 'user-1' },
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
  });

  it('says plainly when this server cannot push to devices', async () => {
    const original = env.WEB_PUSH_VAPID_PUBLIC_KEY;
    env.WEB_PUSH_VAPID_PUBLIC_KEY = undefined;
    mocks.subscriptionCount.mockResolvedValue(0);

    const config = await request(app).get('/api/notifications/push');
    const subscribe = await request(app)
      .post('/api/notifications/push/subscribe')
      .set('Origin', ORIGIN)
      .send({
        endpoint: 'https://push.example/abc',
        keys: { p256dh: 'p256dh-key-material', auth: 'auth-secret' },
      });

    expect(config.body).toEqual({ configured: false, publicKey: null, subscriptions: 0 });
    expect(subscribe.status).toBe(503);
    expect(subscribe.body.error.code).toBe('PUSH_NOT_CONFIGURED');
    env.WEB_PUSH_VAPID_PUBLIC_KEY = original;
  });

  it('refuses a subscription that is not an https push endpoint', async () => {
    const original = env.WEB_PUSH_VAPID_PUBLIC_KEY;
    const originalPrivate = env.WEB_PUSH_VAPID_PRIVATE_KEY;
    env.WEB_PUSH_VAPID_PUBLIC_KEY = 'public';
    env.WEB_PUSH_VAPID_PRIVATE_KEY = 'private';
    env.WEB_PUSH_SUBJECT = 'mailto:push@example.com';

    const response = await request(app)
      .post('/api/notifications/push/subscribe')
      .set('Origin', ORIGIN)
      .send({
        endpoint: 'http://push.example/abc',
        keys: { p256dh: 'p256dh-key-material', auth: 'auth-secret' },
      });

    expect(response.status).toBe(400);
    expect(mocks.subscriptionUpsert).not.toHaveBeenCalled();
    env.WEB_PUSH_VAPID_PUBLIC_KEY = original;
    env.WEB_PUSH_VAPID_PRIVATE_KEY = originalPrivate;
    env.WEB_PUSH_SUBJECT = undefined;
  });

  it('only ever removes the caller’s own subscription', async () => {
    mocks.subscriptionDeleteMany.mockResolvedValue({ count: 1 });
    await request(app)
      .post('/api/notifications/push/unsubscribe')
      .set('Origin', ORIGIN)
      .send({ endpoint: 'https://push.example/abc' });
    expect(mocks.subscriptionDeleteMany).toHaveBeenCalledWith({
      where: { user_id: 'user-1', endpoint: 'https://push.example/abc' },
    });
  });

  it('refuses to mark anything read from an untrusted origin', async () => {
    const response = await request(app)
      .post('/api/notifications/read')
      .set('Origin', 'https://evil.example')
      .send({});
    expect(response.status).toBe(403);
  });
});
