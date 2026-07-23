import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  status: vi.fn(),
  candidates: vi.fn(),
  run: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  defer: vi.fn(),
  merge: vi.fn(),
}));

vi.mock('@web/context/useAuth', () => ({ useAuth: mocks.useAuth }));
vi.mock('@web/queries/labelDiscoveryQueries', () => ({
  useLabelDiscoveryStatus: mocks.status,
  useLabelCandidates: mocks.candidates,
  useLabelDiscoveryActions: () => ({
    run: { mutateAsync: mocks.run, isPending: false },
    approve: { mutateAsync: mocks.approve, isPending: false },
    reject: { mutateAsync: mocks.reject, isPending: false },
    defer: { mutateAsync: mocks.defer, isPending: false },
    merge: { mutateAsync: mocks.merge, isPending: false },
  }),
}));

import { LabelDiscoveryPage } from './LabelDiscoveryPage';

const githubCandidate = {
  id: 'candidate-1',
  candidateType: 'SOURCE',
  suggestedLeafName: 'GitHub',
  suggestedFullPath: 'MailMind/Sources/GitHub',
  status: 'PENDING',
  confidence: 0.91,
  confidenceLevel: 'VERY_HIGH',
  messageCount: 18,
  threadCount: 8,
  dominantCategory: 'NOTIFICATIONS',
  categoryAgreement: 0.9,
  sourceAgreement: 1,
  reasons: ['Frequent source', 'Consistent sender domain'],
  reasonCodes: ['SOURCE_VOLUME', 'DOMAIN_CONSISTENCY'],
  existingLabelConflict: false,
  mergeSuggestion: null,
  decision: null,
  firstMessageAt: null,
  lastMessageAt: null,
  discoveryVersion: 'mailmind-label-discovery-v1',
  lastDiscoveredAt: '2026-07-23T00:00:00.000Z',
};

describe('LabelDiscoveryPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.useAuth.mockReturnValue({ gmailConnection: { connected: true } });
    mocks.status.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        enabled: true,
        running: false,
        pendingCount: 1,
        approvedCount: 0,
        latestRun: { messagesAnalyzed: 30 },
      },
    });
    mocks.candidates.mockReturnValue({
      isLoading: false,
      data: { pages: [{ candidates: [githubCandidate], nextCursor: null }] },
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
    });
    mocks.run.mockResolvedValue({});
    mocks.approve.mockResolvedValue({});
    mocks.reject.mockResolvedValue({});
    mocks.defer.mockResolvedValue({});
    mocks.merge.mockResolvedValue({});
  });

  it('renders candidate evidence and explicit no-Gmail-action wording', () => {
    render(<LabelDiscoveryPage />);
    expect(screen.getByText('MailMind/Sources/GitHub')).toBeInTheDocument();
    expect(screen.getByText('91%')).toBeInTheDocument();
    expect(screen.getByText(/18 messages · 8 threads/i)).toBeInTheDocument();
    expect(screen.getByText(/No Gmail message changes/i)).toBeInTheDocument();
    expect(screen.getByText(/Decisions never apply labels to messages/i)).toBeInTheDocument();
    expect(screen.queryByText(/access token|refresh token|email body/i)).not.toBeInTheDocument();
  });

  it('runs discovery and approves the suggested name', async () => {
    render(<LabelDiscoveryPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Discover labels' }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Approve suggestion' }));
    await waitFor(() => expect(mocks.approve).toHaveBeenCalledWith({ id: 'candidate-1' }));
  });

  it('supports rename, rejection, and defer controls', async () => {
    render(<LabelDiscoveryPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename and approve' }));
    fireEvent.change(screen.getByLabelText('Rename suggestion'), {
      target: { value: 'GitHub Activity' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve suggestion' }));
    await waitFor(() =>
      expect(mocks.approve).toHaveBeenCalledWith({
        id: 'candidate-1',
        leafName: 'GitHub Activity',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Defer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => {
      expect(mocks.defer).toHaveBeenCalledWith('candidate-1');
      expect(mocks.reject).toHaveBeenCalledWith('candidate-1');
    });
  });
});
