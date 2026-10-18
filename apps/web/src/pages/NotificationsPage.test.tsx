import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: {
    getNotifications: vi.fn(),
    markNotificationsRead: vi.fn(),
    getPushConfig: vi.fn(),
    subscribePush: vi.fn(),
    unsubscribePush: vi.fn(),
  },
  push: {
    pushAvailability: vi.fn(),
    currentSubscription: vi.fn(),
    subscribeThisBrowser: vi.fn(),
    unsubscribeThisBrowser: vi.fn(),
  },
}));

vi.mock('@web/services/http', () => ({ api: mocks.api }));
vi.mock('@web/lib/push', () => mocks.push);
vi.mock('@web/context/useAuth', () => ({
  useAuth: () => ({ gmailConnection: { email: 'ada@gmail.com' } }),
}));

import { renderScreen } from '@web/test/renderScreen';
import { NotificationsPage } from './NotificationsPage';
import type { NotificationItem } from '@web/types/notifications';

const item = (overrides: Partial<NotificationItem> = {}): NotificationItem => ({
  id: 'n-1',
  kind: 'NEW_MAIL',
  createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
  readAt: null,
  message: {
    gmailMessageId: '18f0abc',
    subject: 'Your payment failed',
    senderName: 'Netflix',
    senderEmail: 'info@netflix.com',
    snippet: null,
    receivedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
  },
  folder: {
    facetKey: 'entity=netflix|intent=payment-failed',
    path: 'Netflix › Payment failed',
    order: ['entity', 'intent'],
  },
  ...overrides,
});

describe('NotificationsPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.api.getNotifications.mockResolvedValue({
      items: [item()],
      unreadCount: 1,
      nextCursor: null,
    });
    mocks.api.getPushConfig.mockResolvedValue({
      configured: true,
      publicKey: 'BPublicKey',
      subscriptions: 0,
    });
    mocks.api.markNotificationsRead.mockResolvedValue(undefined);
    mocks.push.pushAvailability.mockReturnValue('default');
    mocks.push.currentSubscription.mockResolvedValue(null);
  });

  afterEach(() => vi.restoreAllMocks());

  it('lists new mail with its sender, subject, folder and a link to it in Gmail', async () => {
    renderScreen(<NotificationsPage />, '/notifications');

    expect(await screen.findByText('Netflix')).toBeInTheDocument();
    expect(screen.getByText('Your payment failed')).toBeInTheDocument();
    expect(screen.getByText('Netflix › Payment failed')).toBeInTheDocument();
    expect(screen.getByText('3 min ago')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in Gmail' })).toHaveAttribute(
      'href',
      'https://mail.google.com/mail/?authuser=ada%40gmail.com#all/18f0abc',
    );
    expect(screen.getByRole('link', { name: 'Show folder' }).getAttribute('href')).toContain(
      'folder=entity%3Dnetflix%7Cintent%3Dpayment-failed',
    );
  });

  it('marks everything read in one tap', async () => {
    renderScreen(<NotificationsPage />, '/notifications');

    await userEvent.click(await screen.findByRole('button', { name: 'Mark all as read' }));

    await waitFor(() => expect(mocks.api.markNotificationsRead).toHaveBeenCalledWith(undefined));
  });

  it('turns device notifications on: browser permission first, then the server', async () => {
    const subscription = {
      endpoint: 'https://push.example/abc',
      keys: { p256dh: 'p256dh-key-material', auth: 'auth-secret' },
    };
    mocks.push.subscribeThisBrowser.mockResolvedValue(subscription);
    mocks.api.subscribePush.mockResolvedValue(undefined);
    renderScreen(<NotificationsPage />, '/notifications');

    expect(await screen.findByText('Off for this device')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Turn on' }));

    await waitFor(() => expect(mocks.api.subscribePush).toHaveBeenCalledWith(subscription));
    expect(mocks.push.subscribeThisBrowser).toHaveBeenCalledWith('BPublicKey');
    expect(await screen.findByText('On for this device')).toBeInTheDocument();
  });

  it('turns them off again, and tells the server to forget this browser', async () => {
    mocks.push.currentSubscription.mockResolvedValue({ endpoint: 'https://push.example/abc' });
    mocks.push.unsubscribeThisBrowser.mockResolvedValue('https://push.example/abc');
    mocks.api.unsubscribePush.mockResolvedValue(undefined);
    renderScreen(<NotificationsPage />, '/notifications');

    await userEvent.click(await screen.findByRole('button', { name: 'Turn off' }));

    await waitFor(() =>
      expect(mocks.api.unsubscribePush).toHaveBeenCalledWith('https://push.example/abc'),
    );
  });

  it('explains how to undo a refusal rather than offering a button that cannot work', async () => {
    mocks.push.pushAvailability.mockReturnValue('denied');
    renderScreen(<NotificationsPage />, '/notifications');

    expect(await screen.findByText('Blocked in this browser')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn on' })).not.toBeInTheDocument();
  });

  it('says so when the server is not set up to push', async () => {
    mocks.api.getPushConfig.mockResolvedValue({
      configured: false,
      publicKey: null,
      subscriptions: 0,
    });
    renderScreen(<NotificationsPage />, '/notifications');

    expect(await screen.findByText('Not switched on for this server yet')).toBeInTheDocument();
  });
});
