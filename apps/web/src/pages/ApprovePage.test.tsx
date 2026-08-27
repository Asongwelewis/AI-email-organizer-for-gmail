import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getLabels: vi.fn(),
  proposeLabels: vi.fn(),
  approvePlan: vi.fn(),
}));

vi.mock('@web/services/http', () => ({ api: mocks }));

import { apiError, renderScreen } from '@web/test/renderScreen';
import { ApprovePage } from './ApprovePage';
import type { TaxonomyPlan, TaxonomyPlanNode } from '@web/types/labels';

function node(overrides: Partial<TaxonomyPlanNode> & { id: string; name: string }) {
  return {
    parentId: null,
    depth: 1,
    kind: 'CATEGORY' as const,
    fullPath: `MailMind/${overrides.name}`,
    path: overrides.name,
    rationale: 'Mail about this arrives from many senders.',
    estimatedMessageCount: 40,
    matchedMessageCount: 12,
    rolledUpMessageCount: 18,
    isLeaf: true,
    gmailLabelPath: null,
    rules: [],
    ...overrides,
  };
}

function plan(nodes: TaxonomyPlanNode[], warnings: string[] = []): TaxonomyPlan {
  return {
    id: '00000000-0000-4000-8000-000000000020',
    status: 'PENDING',
    model: 'gemini-flash-lite-latest',
    promptVersion: 'mailmind-taxonomy-planner-v1',
    sampledMessageCount: 500,
    analyzedMessageCount: 596,
    leafCount: nodes.filter((item) => item.isLeaf).length,
    warnings,
    createdAt: '2026-08-20T00:00:00.000Z',
    nodes,
  };
}

const TREE = [
  node({ id: 'job', name: 'Job hunt', isLeaf: false }),
  node({
    id: 'sent',
    name: 'Applications sent',
    parentId: 'job',
    depth: 2,
    path: 'Job hunt/Applications sent',
    rules: [{ kind: 'SENDER_DOMAIN', value: 'greenhouse.io', matchedMessageCount: 6 }],
  }),
];

describe('ApprovePage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getLabels.mockResolvedValue({ maxLabels: 40, maxDepth: 3, labels: [], plan: null });
  });

  it('renders the proposed tree with counts, rationale and routing rules', async () => {
    mocks.getLabels.mockResolvedValue({
      maxLabels: 40,
      maxDepth: 3,
      labels: [],
      plan: plan(TREE),
    });
    renderScreen(<ApprovePage />, '/approve');

    expect(await screen.findByText('Job hunt')).toBeInTheDocument();
    expect(screen.getByText('Applications sent')).toBeInTheDocument();
    expect(screen.getByText('SENDER_DOMAIN')).toBeInTheDocument();
    expect(screen.getByText(/greenhouse\.io/)).toBeInTheDocument();
  });

  // The defect that started all of this: an empty proposal reported as success.
  it('states plainly that a plan proposed no folders, with no success message', async () => {
    mocks.getLabels.mockResolvedValue({
      maxLabels: 40,
      maxDepth: 3,
      labels: [],
      plan: plan([]),
    });
    renderScreen(<ApprovePage />, '/approve');

    expect(await screen.findByText('The planner proposed no folders')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Approve/ })).not.toBeInTheDocument();
  });

  it('shows an empty state rather than a blank screen when nothing is waiting', async () => {
    renderScreen(<ApprovePage />, '/approve');
    expect(await screen.findByText('No proposal waiting')).toBeInTheDocument();
  });

  it('surfaces a failed planning run inline, with its code, and keeps it on screen', async () => {
    const user = userEvent.setup();
    mocks.proposeLabels.mockRejectedValue(
      apiError('LABEL_PROPOSAL_NOT_ENOUGH_MAIL', 'Synchronize more mail before proposing.', 422),
    );
    renderScreen(<ApprovePage />, '/approve');

    await user.click(await screen.findByRole('button', { name: 'Propose folders' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText('The planning run failed')).toBeInTheDocument();
    expect(screen.getByText('LABEL_PROPOSAL_NOT_ENOUGH_MAIL')).toBeInTheDocument();
    expect(screen.getByText('Synchronize more mail before proposing.')).toBeInTheDocument();
  });

  it('surfaces an approval failure inline with its code', async () => {
    const user = userEvent.setup();
    mocks.getLabels.mockResolvedValue({
      maxLabels: 40,
      maxDepth: 3,
      labels: [],
      plan: plan(TREE),
    });
    mocks.approvePlan.mockRejectedValue(
      apiError('LABEL_PLAN_NOT_PENDING', 'That plan was already reviewed.', 409),
    );
    renderScreen(<ApprovePage />, '/approve');

    await user.click(await screen.findByRole('button', { name: /^Approve/ }));

    await waitFor(() => expect(screen.getByText('LABEL_PLAN_NOT_PENDING')).toBeInTheDocument());
    expect(screen.getByText('That plan was already reviewed.')).toBeInTheDocument();
  });

  it('approves the whole tree when nothing was excluded', async () => {
    const user = userEvent.setup();
    mocks.getLabels.mockResolvedValue({
      maxLabels: 40,
      maxDepth: 3,
      labels: [],
      plan: plan(TREE),
    });
    mocks.approvePlan.mockResolvedValue({ maxLabels: 40, maxDepth: 3, labels: [], plan: null });
    renderScreen(<ApprovePage />, '/approve');

    await user.click(await screen.findByRole('button', { name: /^Approve/ }));

    await waitFor(() =>
      expect(mocks.approvePlan).toHaveBeenCalledWith({
        planId: '00000000-0000-4000-8000-000000000020',
      }),
    );
  });

  // Dropping a parent has to drop what sits under it: a child cannot be created without it.
  it('excludes a folder and everything beneath it from the approval', async () => {
    const user = userEvent.setup();
    mocks.getLabels.mockResolvedValue({
      maxLabels: 40,
      maxDepth: 3,
      labels: [],
      plan: plan([...TREE, node({ id: 'money', name: 'Money in' })]),
    });
    mocks.approvePlan.mockResolvedValue({ maxLabels: 40, maxDepth: 3, labels: [], plan: null });
    renderScreen(<ApprovePage />, '/approve');

    await user.click(await screen.findByRole('checkbox', { name: 'Keep Job hunt' }));
    await user.click(screen.getByRole('button', { name: /^Approve/ }));

    await waitFor(() => expect(mocks.approvePlan).toHaveBeenCalled());
    const nodeIds = mocks.approvePlan.mock.calls[0]?.[0].nodeIds as string[];
    expect(nodeIds).toEqual(['money']);
  });

  it('counts only the leaves that survive the exclusions', async () => {
    const user = userEvent.setup();
    mocks.getLabels.mockResolvedValue({
      maxLabels: 40,
      maxDepth: 3,
      labels: [],
      plan: plan([...TREE, node({ id: 'money', name: 'Money in' })]),
    });
    renderScreen(<ApprovePage />, '/approve');

    expect(await screen.findByRole('button', { name: 'Approve 2 folders' })).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Keep Job hunt' }));
    expect(screen.getByRole('button', { name: 'Approve 1 folders' })).toBeInTheDocument();
  });

  it('lists what the validator rejected alongside the tree', async () => {
    mocks.getLabels.mockResolvedValue({
      maxLabels: 40,
      maxDepth: 3,
      labels: [],
      plan: plan(TREE, ['Dropped "Job hunt/Offers": no subject pattern in the sample.']),
    });
    renderScreen(<ApprovePage />, '/approve');

    expect(await screen.findByText('1 suggestion was rejected')).toBeInTheDocument();
  });
});
