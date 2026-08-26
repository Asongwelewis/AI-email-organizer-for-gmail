import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getLabels: vi.fn(),
  getGmailStatus: vi.fn(),
  getFolderMessages: vi.fn(),
}));

vi.mock('@web/services/http', () => ({ api: mocks }));

import { apiError, renderScreen } from '@web/test/renderScreen';
import { SortedPage } from './SortedPage';
import type { UserLabel } from '@web/types/labels';

function label(overrides: Partial<UserLabel> & { id: string; leafName: string }): UserLabel {
  return {
    parentId: null,
    depth: 1,
    fullPath: `MailMind/${overrides.leafName}`,
    path: overrides.leafName,
    isLeaf: true,
    rationale: null,
    messageCount: null,
    source: 'AI_PROPOSED',
    gmailLabelId: 'Label_1',
    createdAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

const TREE: UserLabel[] = [
  label({ id: 'job', leafName: 'Job hunt', isLeaf: false, messageCount: 40 }),
  label({
    id: 'sent',
    leafName: 'Applications sent',
    parentId: 'job',
    depth: 2,
    path: 'Job hunt/Applications sent',
    messageCount: 25,
  }),
  label({ id: 'money', leafName: 'Money in', messageCount: 12 }),
];

describe('SortedPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getLabels.mockResolvedValue({ maxLabels: 40, maxDepth: 3, labels: TREE, plan: null });
    mocks.getGmailStatus.mockResolvedValue({ connected: true, email: 'person@example.com' });
    mocks.getFolderMessages.mockResolvedValue({ messages: [], total: 0 });
  });

  it('shows only the top level of the tree as tiles, with counts', async () => {
    renderScreen(<SortedPage />, '/sorted');

    expect(await screen.findByRole('button', { name: /Job hunt/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Money in/ })).toBeInTheDocument();
    // A child folder belongs to its parent's level, not the root grid.
    expect(screen.queryByRole('button', { name: /Applications sent/ })).not.toBeInTheDocument();
    expect(screen.getByText('40')).toBeInTheDocument();
  });

  it('drills into a folder and lists the mail filed there', async () => {
    const user = userEvent.setup();
    mocks.getFolderMessages.mockResolvedValue({
      total: 1,
      messages: [
        {
          id: 'row-1',
          gmailMessageId: '18f2a9c4b1',
          subject: 'Your application was sent',
          senderName: 'LinkedIn',
          senderEmail: 'jobs@linkedin.com',
          receivedAt: '2026-08-19T09:30:00.000Z',
        },
      ],
    });
    renderScreen(<SortedPage />, '/sorted');

    await user.click(await screen.findByRole('button', { name: /Job hunt/ }));

    expect(await screen.findByRole('button', { name: /Applications sent/ })).toBeInTheDocument();
    const link = await screen.findByRole('link', { name: /Your application was sent/ });
    // #all/ because filed mail left the inbox; authuser= because several accounts may be signed in.
    expect(link).toHaveAttribute(
      'href',
      'https://mail.google.com/mail/?authuser=person%40example.com#all/18f2a9c4b1',
    );
  });

  it('searches the whole tree, not just the level in view', async () => {
    const user = userEvent.setup();
    renderScreen(<SortedPage />, '/sorted');
    await screen.findByRole('button', { name: /Job hunt/ });

    await user.type(screen.getByRole('searchbox', { name: 'Search folders' }), 'applications');

    expect(await screen.findByRole('button', { name: /Applications sent/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Money in/ })).not.toBeInTheDocument();
  });

  it('says so when nothing matches instead of showing an empty grid', async () => {
    const user = userEvent.setup();
    renderScreen(<SortedPage />, '/sorted');
    await screen.findByRole('button', { name: /Job hunt/ });

    await user.type(screen.getByRole('searchbox', { name: 'Search folders' }), 'zzz');

    expect(await screen.findByText('No folder matches')).toBeInTheDocument();
  });

  it('renders an explicit empty state when no folder has been approved yet', async () => {
    mocks.getLabels.mockResolvedValue({ maxLabels: 40, maxDepth: 3, labels: [], plan: null });
    renderScreen(<SortedPage />, '/sorted');

    expect(await screen.findByText('No folders yet')).toBeInTheDocument();
  });

  it('surfaces the API error code inline when folders cannot be loaded', async () => {
    mocks.getLabels.mockRejectedValue(
      apiError('GMAIL_ACCOUNT_NOT_CONNECTED', 'Connect Gmail before using labels.', 409),
    );
    renderScreen(<SortedPage />, '/sorted');

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText('GMAIL_ACCOUNT_NOT_CONNECTED')).toBeInTheDocument();
    expect(screen.getByText('Connect Gmail before using labels.')).toBeInTheDocument();
  });

  /**
   * The first-run failure this rebuild exists to remove: an empty Sorted screen whose only route
   * onwards was Approve, which answered 409 because Gmail had never been connected.
   */
  it('sends an unconnected account to Setup, not to Approve', async () => {
    mocks.getLabels.mockResolvedValue({ labels: [], plan: null });
    mocks.getGmailStatus.mockResolvedValue({ connected: false, email: null });
    renderScreen(<SortedPage />, '/sorted');

    const link = await screen.findByRole('link', { name: /set up mailmind/i });
    expect(link).toHaveAttribute('href', '/setup');
  });

  it('sends a connected account with no folders to the folder shape', async () => {
    mocks.getLabels.mockResolvedValue({ labels: [], plan: null });
    mocks.getGmailStatus.mockResolvedValue({ connected: true, email: 'user@example.com' });
    renderScreen(<SortedPage />, '/sorted');

    const link = await screen.findByRole('link', { name: /shape my folders/i });
    expect(link).toHaveAttribute('href', '/folders');
  });
});
