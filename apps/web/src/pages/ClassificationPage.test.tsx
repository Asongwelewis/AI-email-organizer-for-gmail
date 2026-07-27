import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dedupeRecommendationResults } from '@web/features/classification/dedupeRecommendationResults';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  status: vi.fn(),
  results: vi.fn(),
  run: vi.fn(),
  correct: vi.fn(),
  sync: vi.fn(),
}));

vi.mock('@web/context/useAuth', () => ({ useAuth: mocks.useAuth }));
vi.mock('@web/queries/classificationQueries', () => ({
  useClassificationStatus: mocks.status,
  useClassificationResults: mocks.results,
  useClassificationActions: () => ({
    run: { mutateAsync: mocks.run, isPending: false },
    correct: { mutateAsync: mocks.correct, isPending: false },
  }),
}));
vi.mock('@web/queries/gmailQueries', () => ({
  useGmailSyncStatusQuery: mocks.sync,
}));

import { ClassificationPage } from './ClassificationPage';

describe('ClassificationPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.useAuth.mockReturnValue({ gmailConnection: { connected: true } });
    mocks.sync.mockReturnValue({
      isLoading: false,
      data: {
        status: 'READY',
        initialSyncCompleted: true,
        totalGmailMessages: 257,
        syncedMessages: 257,
        classifiedMessages: 7,
        unprocessedMessages: 250,
        syncRunning: false,
        backfill: {
          running: false,
          completed: true,
          messagesProcessed: 257,
          totalMessages: 257,
          pagesCompleted: 2,
          checkpointedAt: '2026-07-26T00:00:00.000Z',
        },
      },
    });
    mocks.status.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        enabled: false,
        provider: 'disabled',
        running: false,
        classifiedCount: 3,
        reviewRequiredCount: 1,
        latestRun: { ruleClassifiedCount: 2, aiClassifiedCount: 0 },
      },
    });
    mocks.results.mockReturnValue({
      isLoading: false,
      data: {
        pages: [
          {
            nextCursor: null,
            results: [
              {
                id: 'result-id',
                messageId: 'message-id',
                message: {
                  subject: 'Weekly update',
                  sender: 'Updates',
                  senderDomain: 'example.com',
                  snippet: 'A synchronized metadata snippet',
                  gmailLabels: ['INBOX'],
                  date: null,
                },
                recommendedCategory: 'NEWSLETTERS',
                suggestedAction: 'REVIEW_REQUIRED',
                confidence: 0.61,
                requiresReview: true,
                explanation: 'Evidence is limited.',
                reasonCodes: ['NEWSLETTER_TERMS'],
                source: 'RULE',
                status: 'NEEDS_REVIEW',
                classifiedAt: '2026-01-01T00:00:00.000Z',
                correction: null,
              },
            ],
          },
        ],
      },
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
    });
    mocks.run.mockResolvedValue({ success: true });
    mocks.correct.mockResolvedValue({});
  });

  it('renders recommendations, confidence, disabled provider, and no-mutation wording', () => {
    render(<ClassificationPage />);
    expect(screen.getByText('Weekly update')).toBeInTheDocument();
    expect(screen.getByText('61%')).toBeInTheDocument();
    expect(screen.getByText('Rules-only mode')).toBeInTheDocument();
    expect(screen.getByText(/No automatic Gmail changes/i)).toBeInTheDocument();
    expect(screen.getByText(/Saving this correction does not modify Gmail/i)).toBeInTheDocument();
    expect(screen.getByText('250')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Explain Unprocessed' })).toBeInTheDocument();
    expect(screen.getByText(/Fast, deterministic signals/i)).toBeInTheDocument();
    expect(screen.getByText(/Primary classifier for unresolved mail/i)).toBeInTheDocument();
    expect(screen.queryByText(/access token|refresh token|api key/i)).not.toBeInTheDocument();
  });

  it('deduplicates cached recommendation pages by stable Gmail message record id', () => {
    const duplicate = {
      id: 'older-result',
      messageId: 'same-message',
    } as never;
    const newest = {
      id: 'newest-result',
      messageId: 'same-message',
    } as never;
    expect(dedupeRecommendationResults([duplicate, newest])).toEqual([newest]);
  });

  it('runs classification and submits a correction', async () => {
    render(<ClassificationPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Run classification' }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Recommended category'), {
      target: { value: 'WORK' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    await waitFor(() =>
      expect(mocks.correct).toHaveBeenCalledWith({
        id: 'result-id',
        category: 'WORK',
        recommendedAction: 'REVIEW_REQUIRED',
      }),
    );
  });

  it('groups identical cards while correcting each preserved result ID', async () => {
    const current = mocks.results();
    const first = current.data.pages[0].results[0];
    mocks.results.mockReturnValue({
      ...current,
      data: {
        pages: [
          {
            nextCursor: null,
            results: [
              first,
              {
                ...first,
                id: 'result-id-2',
                messageId: 'message-id-2',
              },
            ],
          },
        ],
      },
    });

    render(<ClassificationPage />);
    expect(screen.getByText('2 visually identical messages grouped')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    await waitFor(() => expect(mocks.correct).toHaveBeenCalledTimes(2));
    expect(mocks.correct).toHaveBeenCalledWith(expect.objectContaining({ id: 'result-id-2' }));
  });
});
