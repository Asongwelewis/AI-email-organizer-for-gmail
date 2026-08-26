import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAutomationReview: vi.fn(),
  approveAutomationReview: vi.fn(),
  skipAutomationReview: vi.fn(),
}));

vi.mock('@web/services/http', () => ({ api: mocks }));

import { apiError, renderScreen } from '@web/test/renderScreen';
import { ReviewPage } from './ReviewPage';
import type { AutomationReviewItem } from '@web/types/automation';

function item(overrides: Partial<AutomationReviewItem> = {}): AutomationReviewItem {
  return {
    id: 'action-1',
    labelName: 'Payment failed',
    labelPath: 'MailMind/Netflix/Payment failed',
    confidence: 0.62,
    explanation: 'Billing terms are present but the brand is uncertain.',
    reasonCodes: ['BILLING_TERMS'],
    createdAt: '2026-08-25T00:00:00.000Z',
    message: {
      subject: 'Your payment could not be processed',
      senderName: 'Netflix',
      senderEmail: 'info@netflix.com',
      snippet: 'We were unable to charge your card.',
      receivedAt: '2026-08-24T00:00:00.000Z',
    },
    ...overrides,
  };
}

/**
 * The queue of decisions automation was not confident enough to make alone. Both endpoints have
 * existed since stage 2 and nothing called them, so uncertain decisions have been accumulating
 * with no way to answer them.
 */
describe('ReviewPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getAutomationReview.mockResolvedValue({ items: [] });
    mocks.approveAutomationReview.mockResolvedValue(undefined);
    mocks.skipAutomationReview.mockResolvedValue(undefined);
  });

  it('says the queue is empty rather than showing nothing', async () => {
    renderScreen(<ReviewPage />, '/review');

    expect(await screen.findByText(/nothing waiting/i)).toBeInTheDocument();
  });

  it('shows the message, the folder it suggests and how sure it was', async () => {
    mocks.getAutomationReview.mockResolvedValue({ items: [item()] });
    renderScreen(<ReviewPage />, '/review');

    expect(await screen.findByText('Your payment could not be processed')).toBeInTheDocument();
    expect(screen.getByText('MailMind/Netflix/Payment failed')).toBeInTheDocument();
    expect(screen.getByText('62% sure')).toBeInTheDocument();
    expect(screen.getByText(/billing terms are present/i)).toBeInTheDocument();
  });

  /**
   * The full path, never the leaf. A pivot repeats its lower levels by construction, so "Payment
   * failed" exists under every brand that has one — sending the bare name would be ambiguous and
   * the API refuses it.
   */
  it('approves with the full folder path rather than the leaf name', async () => {
    mocks.getAutomationReview.mockResolvedValue({ items: [item()] });
    renderScreen(<ReviewPage />, '/review');

    await userEvent.click(await screen.findByRole('button', { name: /file it here/i }));

    await waitFor(() =>
      expect(mocks.approveAutomationReview).toHaveBeenCalledWith(
        'action-1',
        'MailMind/Netflix/Payment failed',
      ),
    );
  });

  // Skipping is a decision, not neglect: the message stays in the inbox on purpose.
  it('skips a message without filing it', async () => {
    mocks.getAutomationReview.mockResolvedValue({ items: [item()] });
    renderScreen(<ReviewPage />, '/review');

    await userEvent.click(await screen.findByRole('button', { name: /leave in inbox/i }));

    await waitFor(() => expect(mocks.skipAutomationReview).toHaveBeenCalledWith('action-1'));
    expect(mocks.approveAutomationReview).not.toHaveBeenCalled();
  });

  it('shows the server code when an approval fails', async () => {
    mocks.getAutomationReview.mockResolvedValue({ items: [item()] });
    mocks.approveAutomationReview.mockRejectedValue(
      apiError('AUTOMATION_VALIDATION_FAILED', 'Several folders share that name.', 400),
    );
    renderScreen(<ReviewPage />, '/review');

    await userEvent.click(await screen.findByRole('button', { name: /file it here/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('AUTOMATION_VALIDATION_FAILED');
  });
});
