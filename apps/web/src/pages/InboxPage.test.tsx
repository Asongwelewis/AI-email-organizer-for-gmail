import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPivotSettings: vi.fn(),
  setPivotSettings: vi.fn(),
  getPivotView: vi.fn(),
  getGmailStatus: vi.fn(),
  getFacetMessages: vi.fn(),
  getFavoriteKeys: vi.fn(),
  addFavorite: vi.fn(),
  removeFavorite: vi.fn(),
}));

vi.mock('@web/services/http', () => ({ api: mocks }));

import { apiError, renderScreen } from '@web/test/renderScreen';
import { InboxPage } from './InboxPage';
import type { PivotNode } from '@web/types/facets';

function node(overrides: Partial<PivotNode> & { facetKey: string; leafName: string }): PivotNode {
  return {
    parentFacetKey: null,
    fullPath: `MailMind/${overrides.leafName}`,
    depth: 1,
    messageCount: 0,
    subtreeMessageCount: 0,
    unreadCount: 0,
    subtreeUnreadCount: 0,
    isLeaf: true,
    ...overrides,
  };
}

const TREE: PivotNode[] = [
  node({
    facetKey: 'domain=career',
    leafName: 'Career',
    isLeaf: false,
    subtreeMessageCount: 40,
  }),
  node({
    facetKey: 'domain=career|intent=job-match',
    leafName: 'Job match',
    parentFacetKey: 'domain=career',
    depth: 2,
    fullPath: 'MailMind/Career/Job match',
    messageCount: 25,
    subtreeMessageCount: 25,
  }),
  node({ facetKey: 'domain=finance', leafName: 'Finance', messageCount: 12 }),
];

/**
 * The folder view reads from the facets, not from `user_labels` and not from Gmail.
 *
 * It used to ask for a folder's mail by row id through an endpoint that was never built, so
 * opening a folder 404'd and Gmail's own labels were doing all the organising.
 */
describe('InboxPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    window.localStorage.clear();
    mocks.getPivotSettings.mockResolvedValue({
      canonicalPivot: ['domain', 'intent'],
      minMessages: 5,
    });
    mocks.getPivotView.mockResolvedValue({
      order: ['domain', 'intent'],
      nodes: TREE,
      unfiled: { total: 0, noFacetValue: 0, belowThreshold: 0 },
      collapsed: 0,
    });
    mocks.setPivotSettings.mockResolvedValue({
      canonicalPivot: ['entity', 'intent'],
      minMessages: 5,
    });
    mocks.getGmailStatus.mockResolvedValue({ connected: true, email: 'ada@gmail.com' });
    mocks.getFacetMessages.mockResolvedValue({ messages: [], nextCursor: null, total: 0 });
    mocks.getFavoriteKeys.mockResolvedValue([]);
  });

  /*
   * Logos go through our own API, never straight to a logo service, so the browser does not tell
   * anyone which companies send this person mail. Only brand folders have one.
   */
  it('shows a brand folder with its logo, fetched from our own API', async () => {
    mocks.getPivotSettings.mockResolvedValue({
      canonicalPivot: ['entity', 'intent'],
      minMessages: 5,
    });
    mocks.getPivotView.mockResolvedValue({
      order: ['entity', 'intent'],
      nodes: [
        node({
          facetKey: 'entity=netflix',
          leafName: 'Netflix',
          facet: 'entity',
          value: 'netflix',
          iconDomain: 'netflix.com',
          messageCount: 9,
        }),
        node({ facetKey: 'entity=quiet', leafName: 'Quiet', facet: 'entity', iconDomain: null }),
      ],
      unfiled: { total: 0, noFacetValue: 0, belowThreshold: 0 },
      collapsed: 0,
    });
    const { container } = renderScreen(<InboxPage />, '/inbox');

    await screen.findByText('Netflix');
    const logos = [...container.querySelectorAll('img')].map((image) => image.getAttribute('src'));
    expect(logos).toHaveLength(1);
    expect(logos[0]).toMatch(/\/api\/facets\/icons\/netflix\.com$/);
  });

  it('shows only the top level of the tree as tiles', async () => {
    renderScreen(<InboxPage />, '/inbox');

    expect(await screen.findByText('Career')).toBeInTheDocument();
    expect(screen.getByText('Finance')).toBeInTheDocument();
    // A child is reached by opening its parent, not by being listed beside it.
    expect(screen.queryByText('Job match')).not.toBeInTheDocument();
  });

  /*
   * The grid used to stop at ten folders with no way past it, so "All mail" looked like it held the
   * same ten folders as last week. The newest stay first; every other one is a tap away.
   */
  it('shows the newest folders first and every folder on request', async () => {
    mocks.getPivotView.mockResolvedValue({
      order: ['domain', 'intent'],
      nodes: Array.from({ length: 30 }, (_, index) =>
        node({
          facetKey: `domain=folder-${index}`,
          leafName: `Folder ${index}`,
          subtreeMessageCount: 3,
          // Folder 0 is the newest.
          latestReceivedAt: new Date(Date.UTC(2026, 9, 18, 12) - index * 60_000).toISOString(),
        }),
      ),
      unfiled: { total: 0, noFacetValue: 0, belowThreshold: 0 },
      collapsed: 0,
    });
    renderScreen(<InboxPage />, '/inbox');

    await screen.findByText('Folder 0');
    expect(document.querySelectorAll('.folder-tile')).toHaveLength(24);
    expect(screen.queryByText('Folder 29')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Show all 30 folders' }));

    expect(document.querySelectorAll('.folder-tile')).toHaveLength(30);
    expect(screen.getByText('Folder 29')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show all/i })).not.toBeInTheDocument();
  });

  /*
   * Every folder, current and future, can be starred from its tile. The star fills the moment it
   * is tapped, and the starring is stored against the folder's identity and its arrangement.
   */
  it('stars a folder from its tile, against the folder and the arrangement it is in', async () => {
    mocks.getFavoriteKeys.mockResolvedValue([]);
    // Like the server: once added, the key is among the starred ones.
    mocks.addFavorite.mockImplementation(async () => {
      mocks.getFavoriteKeys.mockResolvedValue(['domain=finance']);
      return {};
    });
    renderScreen(<InboxPage />, '/inbox');

    const star = await screen.findByRole('button', { name: 'Add Finance to favourites' });
    expect(star).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(star);

    expect(mocks.addFavorite).toHaveBeenCalledWith('domain=finance', ['domain', 'intent']);
    expect(
      await screen.findByRole('button', { name: 'Remove Finance from favourites' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the stars already filled for folders that are favourites', async () => {
    mocks.getFavoriteKeys.mockResolvedValue(['domain=career']);
    renderScreen(<InboxPage />, '/inbox');

    expect(
      await screen.findByRole('button', { name: 'Remove Career from favourites' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Finance to favourites' })).toBeInTheDocument();
  });

  it('offers no "show all" when every folder already fits', async () => {
    renderScreen(<InboxPage />, '/inbox');

    await screen.findByText('Career');
    expect(screen.queryByRole('button', { name: /show all/i })).not.toBeInTheDocument();
  });

  /**
   * The whole flow this card exists for: open a folder, see its mail, click through to the
   * original in Gmail. The link addresses the message by id, so it resolves whether or not the
   * message carries any label at all.
   */
  it('drills into a folder and lists its mail, linking each to Gmail', async () => {
    mocks.getFacetMessages.mockResolvedValue({
      total: 1,
      nextCursor: null,
      messages: [
        {
          id: 'row-1',
          gmailMessageId: '18f0abc',
          subject: 'Your application was received',
          senderName: 'LinkedIn',
          senderEmail: 'jobs@linkedin.com',
          snippet: null,
          receivedAt: '2026-08-20T00:00:00.000Z',
          isUnread: false,
          entity: 'linkedin',
          domain: 'career',
          intent: 'job-match',
        },
      ],
    });
    renderScreen(<InboxPage />, '/inbox');

    // The folder itself, not its star, whose label names the folder too.
    await userEvent.click(await screen.findByRole('button', { name: /^(?!.*favourites).*Career/ }));

    await waitFor(() =>
      expect(mocks.getFacetMessages).toHaveBeenCalledWith('domain=career', { range: '24h' }),
    );
    const link = await screen.findByRole('link', { name: /Your application was received/ });
    expect(link).toHaveAttribute('href', expect.stringContaining('#all/18f0abc'));
    expect(link).toHaveAttribute('href', expect.stringContaining('authuser=ada%40gmail.com'));
  });

  // Opening a parent asks "everything under here", so the count is the whole subtree.
  it('counts a parent folder by its subtree', async () => {
    renderScreen(<InboxPage />, '/inbox');

    expect(await screen.findByText('Career')).toBeInTheDocument();
    expect(screen.getByText('40')).toBeInTheDocument();
  });

  it('searches the whole tree, not just the level in view', async () => {
    renderScreen(<InboxPage />, '/inbox');
    await screen.findByText('Career');

    await userEvent.type(screen.getByLabelText('Search folders'), 'job');

    // A nested folder surfaces without retracing the path it sits under.
    expect(await screen.findByText('Job match')).toBeInTheDocument();
  });

  it('says so when nothing matches instead of showing an empty grid', async () => {
    renderScreen(<InboxPage />, '/inbox');
    await screen.findByText('Career');

    await userEvent.type(screen.getByLabelText('Search folders'), 'zzz');

    expect(await screen.findByText('No folder matches')).toBeInTheDocument();
  });

  // The first-run failure: an empty screen whose only route onwards answered 409.
  it('sends an unconnected account to Setup', async () => {
    mocks.getPivotView.mockResolvedValue({
      order: ['domain', 'intent'],
      nodes: [],
      unfiled: { total: 0, noFacetValue: 0, belowThreshold: 0 },
      collapsed: 0,
    });
    mocks.getGmailStatus.mockResolvedValue({ connected: false, email: null });
    renderScreen(<InboxPage />, '/inbox');

    expect(await screen.findByRole('link', { name: /set up mailmind/i })).toHaveAttribute(
      'href',
      '/setup',
    );
  });

  it('sends a connected account with no folders to the folder shape', async () => {
    mocks.getPivotView.mockResolvedValue({
      order: ['domain', 'intent'],
      nodes: [],
      unfiled: { total: 0, noFacetValue: 0, belowThreshold: 0 },
      collapsed: 0,
    });
    renderScreen(<InboxPage />, '/inbox');

    expect(await screen.findByRole('link', { name: /shape my folders/i })).toHaveAttribute(
      'href',
      '/folders',
    );
  });

  /**
   * Card 23. One ordering was materialised because a message carries one MailMind label and no
   * more — a Gmail constraint, not a product one. With Gmail out of the write path every ordering
   * is available at once, and switching costs no reclassification and no remote call.
   */
  it('offers the orderings side by side and switches between them on read', async () => {
    renderScreen(<InboxPage />, '/inbox');
    await screen.findByText('Career');

    await userEvent.click(screen.getByRole('button', { name: /Brand › What it wants/ }));

    await waitFor(() =>
      expect(mocks.getPivotView).toHaveBeenCalledWith(['entity', 'intent'], 5, '24h'),
    );
    // Nothing was applied and nothing was saved: an arrangement is a question, not a change.
    expect(mocks.setPivotSettings).not.toHaveBeenCalled();
  });

  // An ordering in the URL is what makes a view a link.
  it('opens on the ordering the link names rather than the saved one', async () => {
    renderScreen(<InboxPage />, '/inbox?order=intent,entity');

    await waitFor(() =>
      expect(mocks.getPivotView).toHaveBeenCalledWith(['intent', 'entity'], 5, '24h'),
    );
    expect(mocks.getPivotView).not.toHaveBeenCalledWith(['domain', 'intent'], 5, '24h');
  });

  it('changes the default recent-mail window and refetches folders', async () => {
    renderScreen(<InboxPage />, '/inbox');
    await screen.findByText('Career');

    await userEvent.selectOptions(screen.getByLabelText('Show mail from'), '7d');

    await waitFor(() =>
      expect(mocks.getPivotView).toHaveBeenCalledWith(['domain', 'intent'], 5, '7d'),
    );
    expect(window.localStorage.getItem('mailmind_time_range')).toBe('7d');
  });

  // `facet_pivot_settings` stays the remembered default — which arrangement this screen opens on.
  it('remembers an arrangement as the default when asked', async () => {
    renderScreen(<InboxPage />, '/inbox?order=entity,intent');
    await screen.findByText('Career');

    await userEvent.click(await screen.findByRole('button', { name: /make this my default/i }));

    await waitFor(() =>
      expect(mocks.setPivotSettings).toHaveBeenCalledWith({
        canonicalPivot: ['entity', 'intent'],
        minMessages: 5,
      }),
    );
  });

  it('offers no default button on the arrangement that already is one', async () => {
    renderScreen(<InboxPage />, '/inbox');
    await screen.findByText('Career');

    expect(screen.queryByRole('button', { name: /make this my default/i })).not.toBeInTheDocument();
  });

  it('surfaces the API error code inline when folders cannot be loaded', async () => {
    mocks.getPivotView.mockRejectedValue(
      apiError('GMAIL_ACCOUNT_NOT_CONNECTED', 'Connect Gmail first.', 409),
    );
    renderScreen(<InboxPage />, '/inbox');

    expect(await screen.findByRole('alert')).toHaveTextContent('GMAIL_ACCOUNT_NOT_CONNECTED');
  });
});
