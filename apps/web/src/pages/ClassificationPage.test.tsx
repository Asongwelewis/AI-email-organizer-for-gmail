import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  status: vi.fn(),
  results: vi.fn(),
  run: vi.fn(),
  correct: vi.fn(),
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

import { ClassificationPage } from './ClassificationPage';

describe('ClassificationPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.useAuth.mockReturnValue({ gmailConnection: { connected: true } });
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
    expect(screen.queryByText(/access token|refresh token|api key/i)).not.toBeInTheDocument();
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
});
