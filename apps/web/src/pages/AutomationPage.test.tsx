import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  review: vi.fn(),
  run: vi.fn(),
  approve: vi.fn(),
  skip: vi.fn(),
}));

vi.mock('@web/queries/automationQueries', () => ({
  useAutomationStatus: mocks.status,
  useAutomationReview: mocks.review,
  useAutomationActions: () => ({
    run: { mutateAsync: mocks.run, isPending: false },
    approve: { mutateAsync: mocks.approve, isPending: false },
    skip: { mutateAsync: mocks.skip, isPending: false },
  }),
}));

import { AutomationPage } from './AutomationPage';

describe('AutomationPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.status.mockReturnValue({
      isLoading: false,
      data: {
        gmailConnected: true,
        requiresReauthentication: false,
        enabled: true,
        running: false,
        nextRunAt: '2026-07-27T02:00:00.000Z',
        lastRun: {
          id: 'run-1',
          status: 'COMPLETED',
          trigger: 'SCHEDULED',
          messagesSeen: 12,
          patternReused: 7,
          openaiClassified: 5,
          reviewRequired: 1,
          messagesLabeled: 11,
          failed: 0,
          providerCalls: 1,
          inputTokens: 900,
          cachedInputTokens: 200,
          outputTokens: 120,
          estimatedCostMicrousd: 8000,
          stoppedReason: null,
          lastErrorCode: null,
          startedAt: '2026-07-26T02:00:00.000Z',
          completedAt: '2026-07-26T02:00:20.000Z',
        },
        usageToday: {
          providerCalls: 1,
          inputTokens: 900,
          cachedInputTokens: 200,
          outputTokens: 120,
          estimatedCostMicrousd: 8000,
          messagesLabeled: 11,
        },
        limits: {
          inputTokens: 100000,
          outputTokens: 10000,
          estimatedCostMicrousd: 500000,
          messages: 250,
        },
        pendingReviewCount: 1,
      },
    });
    mocks.review.mockReturnValue({
      isLoading: false,
      data: {
        items: [
          {
            id: 'action-1',
            category: 'WORK',
            labelPath: 'MailMind/Work',
            confidence: 0.62,
            explanation: 'The sender context is ambiguous.',
            reasonCodes: ['AMBIGUOUS'],
            createdAt: '2026-07-26T02:00:00.000Z',
            message: {
              subject: 'Project update',
              senderName: 'Alex',
              senderEmail: 'alex@example.com',
              snippet: 'Here is the update.',
              receivedAt: '2026-07-26T01:00:00.000Z',
            },
          },
        ],
      },
    });
    mocks.run.mockResolvedValue({ success: true, status: 'COMPLETED' });
    mocks.approve.mockResolvedValue({});
    mocks.skip.mockResolvedValue({});
  });

  it('shows Gmail state, usage, last run, and uncertain classifications', () => {
    render(<AutomationPage />);
    expect(screen.getByText('Gmail automation ready')).toBeInTheDocument();
    expect(screen.getByText('11')).toBeInTheDocument();
    expect(screen.getByText('Project update')).toBeInTheDocument();
    expect(screen.getByText('62% confidence')).toBeInTheDocument();
  });

  it('supports manual runs and approval that applies a Gmail label', async () => {
    render(<AutomationPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(mocks.run).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Apply as'), { target: { value: 'PERSONAL' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve & apply' }));
    await waitFor(() =>
      expect(mocks.approve).toHaveBeenCalledWith({ id: 'action-1', category: 'PERSONAL' }),
    );
  });

  it('disables manual runs when Gmail is disconnected', () => {
    mocks.status.mockReturnValue({
      ...mocks.status(),
      data: { ...mocks.status().data, gmailConnected: false },
    });
    render(<AutomationPage />);
    expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled();
    expect(screen.getByText('Gmail needs attention')).toBeInTheDocument();
  });
});
