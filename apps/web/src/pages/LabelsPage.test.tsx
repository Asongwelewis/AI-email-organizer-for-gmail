import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  labels: vi.fn(),
  sync: vi.fn(),
  propose: vi.fn(),
  confirm: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@web/queries/labelsQueries', () => ({
  useLabels: mocks.labels,
  useLabelActions: () => ({
    propose: { mutateAsync: mocks.propose, isPending: false },
    confirm: { mutateAsync: mocks.confirm, isPending: false },
    rename: { mutateAsync: mocks.rename, isPending: false },
    remove: { mutateAsync: mocks.remove, isPending: false },
  }),
}));
vi.mock('@web/queries/gmailQueries', () => ({
  useGmailSyncStatusQuery: mocks.sync,
}));

import { LabelsPage } from './LabelsPage';

describe('LabelsPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.sync.mockReturnValue({
      isLoading: false,
      data: {
        status: 'READY',
        initialSyncCompleted: true,
        totalGmailMessages: 120,
        syncedMessages: 120,
        classifiedMessages: 0,
        unprocessedMessages: 120,
        syncRunning: false,
        backfill: {
          running: false,
          completed: true,
          messagesProcessed: 120,
          totalMessages: 120,
          pagesCompleted: 1,
          checkpointedAt: '2026-07-30T00:00:00.000Z',
        },
      },
    });
    mocks.labels.mockReturnValue({
      isLoading: false,
      data: {
        maxLabels: 25,
        labels: [
          {
            id: 'label-1',
            leafName: 'Invoices',
            fullPath: 'MailMind/Invoices',
            source: 'AI_PROPOSED',
            gmailLabelId: 'Label_1',
            createdAt: '2026-07-30T00:00:00.000Z',
          },
        ],
        proposals: [
          {
            id: 'proposal-1',
            leafName: 'Flights',
            fullPath: 'MailMind/Flights',
            confidence: 0.82,
            messageCount: 14,
            reasonCodes: ['SOURCE_VOLUME'],
          },
        ],
      },
    });
    mocks.propose.mockResolvedValue({});
    mocks.confirm.mockResolvedValue({});
    mocks.rename.mockResolvedValue({});
    mocks.remove.mockResolvedValue({});
  });

  it('shows approved labels and pending proposals', () => {
    render(<LabelsPage />);
    expect(screen.getByText('MailMind/Invoices')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Flights')).toBeInTheDocument();
    expect(screen.getByText('1 of 25 labels')).toBeInTheDocument();
  });

  it('requests a fresh proposal set', async () => {
    render(<LabelsPage />);
    fireEvent.click(screen.getByRole('button', { name: /Propose again/i }));
    await waitFor(() => expect(mocks.propose).toHaveBeenCalled());
  });

  it('lets the user rename a proposal and add a custom label before confirming', async () => {
    render(<LabelsPage />);

    fireEvent.change(screen.getByDisplayValue('Flights'), { target: { value: 'Travel' } });
    fireEvent.change(screen.getByPlaceholderText('Add your own label'), {
      target: { value: 'Receipts' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add/i }));

    fireEvent.click(screen.getByRole('button', { name: /Confirm and create in Gmail/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Create labels' }));

    await waitFor(() =>
      expect(mocks.confirm).toHaveBeenCalledWith([
        { leafName: 'Travel', source: 'AI_PROPOSED' },
        { leafName: 'Receipts', source: 'USER_CREATED' },
      ]),
    );
  });

  it('confirms before removing an approved label and keeps the Gmail label', async () => {
    render(<LabelsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Invoices' }));
    expect(screen.getByText(/stay exactly where they are/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop using it' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('label-1'));
  });

  it('does not create anything in Gmail until confirmation', () => {
    render(<LabelsPage />);
    fireEvent.click(screen.getByRole('button', { name: /Confirm and create in Gmail/i }));
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
