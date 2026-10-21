import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getNotifications: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@web/services/http', () => ({ api: { getNotifications: mocks.getNotifications } }));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@web/context/useAuth', () => ({
  useAuth: () => ({ gmailConnection: { connected: true, status: 'CONNECTED' } }),
}));

import { queryKeys } from '@web/queries/queryKeys';
import { NotificationCenter } from './NotificationCenter';
import type { NotificationItem } from '@web/types/notifications';

const item = (id: string, sender: string, readAt: string | null = null): NotificationItem => ({
  id,
  kind: 'NEW_MAIL',
  createdAt: '2026-10-18T12:00:00.000Z',
  readAt,
  message: {
    gmailMessageId: `g-${id}`,
    subject: `Subject ${id}`,
    senderName: sender,
    senderEmail: null,
    snippet: null,
    receivedAt: null,
  },
  folder: null,
});

function renderCenter() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <NotificationCenter />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return queryClient;
}

/*
 * The in-app half of new-mail notifications. It must announce what arrives while the app is open
 * and nothing that was already there — a launch that greets you with every unread email as a toast
 * is noise, not a notification.
 */
describe('NotificationCenter', () => {
  beforeEach(() => vi.resetAllMocks());

  it('stays quiet about what was already there when the app opened', async () => {
    mocks.getNotifications.mockResolvedValue({
      items: [item('a', 'Netflix')],
      unreadCount: 1,
      nextCursor: null,
    });
    renderCenter();

    await waitFor(() => expect(mocks.getNotifications).toHaveBeenCalled());
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('announces mail that arrives while the app is open', async () => {
    mocks.getNotifications.mockResolvedValueOnce({ items: [], unreadCount: 0, nextCursor: null });
    const client = renderCenter();
    // The first answer has to land, or the refetch below would replace it and become the first.
    await waitFor(() => expect(client.getQueryData(queryKeys.notifications)).toBeDefined());

    mocks.getNotifications.mockResolvedValue({
      items: [item('b', 'GitHub')],
      unreadCount: 1,
      nextCursor: null,
    });
    await client.invalidateQueries({ queryKey: queryKeys.notifications });

    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        'GitHub',
        expect.objectContaining({ description: 'Subject b' }),
      ),
    );
  });

  it('sums a burst up in one toast', async () => {
    mocks.getNotifications.mockResolvedValueOnce({ items: [], unreadCount: 0, nextCursor: null });
    const client = renderCenter();
    // The first answer has to land, or the refetch below would replace it and become the first.
    await waitFor(() => expect(client.getQueryData(queryKeys.notifications)).toBeDefined());

    mocks.getNotifications.mockResolvedValue({
      items: ['a', 'b', 'c', 'd'].map((id) => item(id, `Sender ${id}`)),
      unreadCount: 4,
      nextCursor: null,
    });
    await client.invalidateQueries({ queryKey: queryKeys.notifications });

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));
    expect(mocks.toast.mock.calls[0]![0]).toBe('4 new emails');
  });
});
