import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPivotSettings: vi.fn(),
  setPivotSettings: vi.fn(),
  getPivotView: vi.fn(),
  applyPivot: vi.fn(),
  fileFacets: vi.fn(),
}));

vi.mock('@web/services/http', () => ({ api: mocks }));

import { apiError, renderScreen } from '@web/test/renderScreen';
import { PivotPage } from './PivotPage';

const view = (overrides = {}) => ({
  order: ['entity', 'intent'],
  nodes: [
    {
      facetKey: 'entity=netflix',
      fullPath: 'MailMind/Netflix',
      leafName: 'Netflix',
      depth: 1,
      messageCount: 0,
      subtreeMessageCount: 42,
      isLeaf: false,
    },
    {
      facetKey: 'entity=netflix|intent=payment-failed',
      fullPath: 'MailMind/Netflix/Payment failed',
      leafName: 'Payment failed',
      depth: 2,
      messageCount: 42,
      subtreeMessageCount: 42,
      isLeaf: true,
    },
  ],
  unfiled: { total: 7, noFacetValue: 2, belowThreshold: 5 },
  collapsed: 3,
  ...overrides,
});

/**
 * Facets are orthogonal, so a folder tree is a view of them. This screen is where that becomes
 * usable: every arrangement below is computed on read, and only Apply touches the mailbox.
 */
describe('PivotPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getPivotSettings.mockResolvedValue({
      canonicalPivot: ['entity', 'intent'],
      minMessages: 5,
    });
    mocks.getPivotView.mockResolvedValue(view());
    mocks.setPivotSettings.mockResolvedValue({
      canonicalPivot: ['intent', 'entity'],
      minMessages: 5,
    });
    mocks.applyPivot.mockResolvedValue({
      gmailLabelsCreated: 2,
      gmailLabelsReused: 1,
      orphaned: [],
    });
    mocks.fileFacets.mockResolvedValue({ runId: 'run-1', state: 'RUNNING' });
  });

  it('shows the stored ordering and the tree it produces', async () => {
    renderScreen(<PivotPage />, '/folders');

    expect(await screen.findByText('Brand')).toBeInTheDocument();
    expect(screen.getByText('What it wants')).toBeInTheDocument();
    expect(await screen.findByText('Payment failed')).toBeInTheDocument();
    expect(screen.getByText(/7 staying in the inbox/)).toBeInTheDocument();
    /*
     * `unfiled` is a breakdown, not a count. Rendering the object itself printed nothing useful,
     * and the fixture agreed with the bug — which is why the split is asserted rather than the
     * total alone. It is also what makes the floor tunable: mail below the threshold comes back
     * by lowering it, mail with no facet value does not.
     */
    expect(screen.getByText(/5 of them just below the floor/)).toBeInTheDocument();
  });

  /**
   * The whole point of the screen: reordering recomputes nothing about the mail and touches
   * nothing in Gmail. It is a different arrangement of the same facet rows.
   */
  it('previews a new ordering without touching Gmail', async () => {
    renderScreen(<PivotPage />, '/folders');

    await userEvent.click(await screen.findByRole('button', { name: /move what it wants up/i }));

    await waitFor(() => expect(mocks.getPivotView).toHaveBeenCalledWith(['intent', 'entity'], 5));
    expect(mocks.applyPivot).not.toHaveBeenCalled();
    expect(mocks.setPivotSettings).not.toHaveBeenCalled();
  });

  // Apply materialises whatever is canonical, so applying an unsaved ordering would build the old
  // shape and quietly discard what is on screen.
  it('saves the ordering before applying it', async () => {
    renderScreen(<PivotPage />, '/folders');

    await userEvent.click(await screen.findByRole('button', { name: /move what it wants up/i }));
    await userEvent.click(await screen.findByRole('button', { name: /save and apply/i }));

    await waitFor(() => expect(mocks.applyPivot).toHaveBeenCalled());
    expect(mocks.setPivotSettings).toHaveBeenCalledWith({
      canonicalPivot: ['intent', 'entity'],
      minMessages: 5,
    });
    expect(mocks.setPivotSettings.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.applyPivot.mock.invocationCallOrder[0]!,
    );
  });

  // Deleting a Gmail label never unlabels its mail, so a pivot reports what no longer matches
  // instead of removing it. The screen has to say that, or the folders look like a bug.
  it('says what it left alone rather than implying it cleaned up', async () => {
    mocks.applyPivot.mockResolvedValue({
      gmailLabelsCreated: 1,
      gmailLabelsReused: 0,
      orphaned: [{ id: 'row', fullPath: 'MailMind/Old', gmailLabelId: 'Label_old' }],
    });
    renderScreen(<PivotPage />, '/folders');

    await userEvent.click(await screen.findByRole('button', { name: /apply to gmail/i }));

    expect(await screen.findByText(/left alone/i)).toBeInTheDocument();
  });

  it('files mail through the pivot as a background run', async () => {
    renderScreen(<PivotPage />, '/folders');

    await userEvent.click(await screen.findByRole('button', { name: /file my mail/i }));

    await waitFor(() => expect(mocks.fileFacets).toHaveBeenCalled());
    expect(await screen.findByText(/filing started/i)).toBeInTheDocument();
  });

  it('shows the server code when applying fails', async () => {
    mocks.applyPivot.mockRejectedValue(
      apiError('AUTOMATION_NO_APPROVED_LABELS', 'The pivot produced no folders.', 409),
    );
    renderScreen(<PivotPage />, '/folders');

    await userEvent.click(await screen.findByRole('button', { name: /apply to gmail/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('AUTOMATION_NO_APPROVED_LABELS');
  });

  it('explains an empty tree instead of rendering nothing', async () => {
    mocks.getPivotView.mockResolvedValue(view({ nodes: [], collapsed: 40 }));
    renderScreen(<PivotPage />, '/folders');

    expect(await screen.findByText(/no folders at this shape/i)).toBeInTheDocument();
  });
});
