import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  searchMessages: vi.fn(),
  getFacetVocabulary: vi.fn(),
  getGmailStatus: vi.fn(),
}));

vi.mock('@web/services/http', () => ({ api: mocks }));

import { apiError, renderScreen } from '@web/test/renderScreen';
import { FindPage } from './FindPage';

const hit = (overrides = {}) => ({
  id: 'row-1',
  gmailMessageId: '18f0abc',
  subject: 'Your payment failed',
  senderName: 'Netflix',
  senderEmail: 'billing@netflix.com',
  snippet: null,
  receivedAt: '2026-08-20T00:00:00.000Z',
  isUnread: false,
  entity: 'netflix',
  domain: 'finance',
  intent: 'payment-failed',
  folder: {
    facetKey: 'domain=finance|intent=payment-failed',
    fullPath: 'MailMind/Finance/Payment failed',
    leafName: 'Payment failed',
  },
  ...overrides,
});

const results = (overrides = {}) => ({
  query: 'payment',
  filters: { entity: null, domain: null, intent: null },
  order: ['domain', 'intent'],
  results: [hit()],
  folders: [
    {
      facetKey: 'domain=finance|intent=payment-failed',
      fullPath: 'MailMind/Finance/Payment failed',
      leafName: 'Payment failed',
      count: 1,
    },
  ],
  total: 1,
  nextCursor: null,
  ...overrides,
});

/**
 * Card 24. Folders are half of findability; this screen is the other half — the message you can
 * only half remember, found across the whole mailbox rather than one folder at a time.
 */
describe('FindPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getFacetVocabulary.mockResolvedValue({
      entity: [{ value: 'netflix', messageCount: 40 }],
      domain: [{ value: 'finance', messageCount: 52 }],
      intent: [
        { value: 'payment-failed', messageCount: 9 },
        { value: 'newsletter', messageCount: 0 },
      ],
    });
    mocks.searchMessages.mockResolvedValue(results());
    mocks.getGmailStatus.mockResolvedValue({ connected: true, email: 'ada@gmail.com' });
  });

  // A search constraining nothing is the mailbox, and the API refuses it. Do not ask in the first
  // place — an empty screen that also logged a 400 would be two failures rather than one prompt.
  it('asks for nothing until there is something to search for', async () => {
    renderScreen(<FindPage />, '/find');

    expect(await screen.findByText(/search your whole mailbox/i)).toBeInTheDocument();
    expect(mocks.searchMessages).not.toHaveBeenCalled();
  });

  it('finds a message by part of its subject and links it to Gmail', async () => {
    renderScreen(<FindPage />, '/find');

    await userEvent.type(screen.getByLabelText(/search your mail/i), 'payment');

    await waitFor(() => expect(mocks.searchMessages).toHaveBeenCalled());
    const link = await screen.findByRole('link', { name: /Your payment failed/ });
    expect(link).toHaveAttribute('href', expect.stringContaining('#all/18f0abc'));
    expect(link).toHaveAttribute('href', expect.stringContaining('authuser=ada%40gmail.com'));
  });

  // Half of what the person was asking is "where was it": the row itself carries its folder, so a
  // message read on its own still says where it lives — not only the group heading above it.
  it('says which folder each hit sits in', async () => {
    renderScreen(<FindPage />, '/find?q=payment');

    const row = await screen.findByRole('link', { name: /Your payment failed/ });
    expect(row.textContent).toContain('Finance / Payment failed');
  });

  /**
   * The thing a Gmail label tree genuinely cannot do: one intent across every brand at once,
   * because a tree expresses one ordering of the facets and this asks about another.
   */
  it('filters by facet with no phrase at all', async () => {
    renderScreen(<FindPage />, '/find');
    // The options come from the account's own vocabulary, so wait for it rather than the screen.
    await screen.findByRole('option', { name: /payment failed/i });

    await userEvent.selectOptions(screen.getByLabelText('What it wants'), 'payment-failed');

    await waitFor(() =>
      expect(mocks.searchMessages).toHaveBeenCalledWith('', { intent: 'payment-failed' }, {}),
    );
  });

  // A search worth keeping is a link, the same reason an arrangement is.
  it('opens on the search the link carries', async () => {
    renderScreen(<FindPage />, '/find?q=invoice&entity=netflix');

    await waitFor(() =>
      expect(mocks.searchMessages).toHaveBeenCalledWith('invoice', { entity: 'netflix' }, {}),
    );
  });

  it('says nothing matched instead of showing an empty list', async () => {
    mocks.searchMessages.mockResolvedValue(results({ results: [], total: 0 }));
    renderScreen(<FindPage />, '/find?q=zzz');

    expect(await screen.findByText(/nothing matches/i)).toBeInTheDocument();
  });

  it('surfaces the server code when a search fails', async () => {
    mocks.searchMessages.mockRejectedValue(
      apiError('FACET_VALIDATION_FAILED', 'A search needs a phrase or at least one facet.', 400),
    );
    renderScreen(<FindPage />, '/find?q=payment');

    expect(await screen.findByRole('alert')).toHaveTextContent('FACET_VALIDATION_FAILED');
  });

  /**
   * The whole point over a plain mailbox: the answer leads with where the mail is, not with a flat
   * list of messages indistinguishable from the inbox it came from.
   */
  it('leads with the folders holding the results, not a flat list', async () => {
    renderScreen(<FindPage />, '/find?q=payment');

    const group = await screen.findByRole('button', { name: /Finance \/ Payment failed/ });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Everything/ })).toBeInTheDocument();
  });

  // Unread on its own is the "what arrived that I have not seen" question.
  it('searches unread with no phrase at all', async () => {
    renderScreen(<FindPage />, '/find?unread=true');

    await waitFor(() =>
      expect(mocks.searchMessages).toHaveBeenCalledWith('', { unread: true }, {}),
    );
  });

  // One combination in a real mailbox holds 1,823 messages, so results page.
  it('pages through older results with the cursor the server sent', async () => {
    mocks.searchMessages
      .mockResolvedValueOnce(results({ total: 2, nextCursor: 'row-1' }))
      .mockResolvedValueOnce(results({ results: [hit({ id: 'row-2' })], total: 2 }));
    renderScreen(<FindPage />, '/find?q=payment');

    await userEvent.click(await screen.findByRole('button', { name: /show older/i }));

    await waitFor(() =>
      expect(mocks.searchMessages).toHaveBeenLastCalledWith('payment', {}, { cursor: 'row-1' }),
    );
  });
});
