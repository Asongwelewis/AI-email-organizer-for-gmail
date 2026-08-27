import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auditRecord: vi.fn(),
  activeAccountForUser: vi.fn(),
  approvedLabels: vi.fn(),
  pendingPlan: vi.fn(),
  planForAccount: vi.fn(),
  storePlan: vi.fn(),
  markPlanApproved: vi.fn(),
  replacePlannerRules: vi.fn(),
  acquireProposalLease: vi.fn(),
  releaseProposalLease: vi.fn(),
  eligibleMessages: vi.fn(),
  existingGmailLabelNames: vi.fn(),
  createLabel: vi.fn(),
  setGmailLabelId: vi.fn(),
  renameLabel: vi.fn(),
  deleteLabel: vi.fn(),
  labelForAccount: vi.fn(),
  descendantsOf: vi.fn(),
}));

vi.mock('../src/audit/audit.service.js', () => ({
  auditService: { record: mocks.auditRecord },
}));
vi.mock('../src/config/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  safeErrorDetails: () => ({}),
}));

import { LabelsService } from '../src/features/labels/labels.service.js';
import type { LabelsRepository } from '../src/features/labels/labels.repository.js';
import type { TaxonomyPlanner } from '../src/features/label-discovery/taxonomy-planner.js';

const account = { id: 'account-1', user_id: 'user-1' };

function label(
  leafName: string,
  options: {
    gmailLabelId?: string | null;
    parentId?: string | null;
    depth?: number;
    path?: string;
  } = {},
) {
  const path = options.path ?? leafName;
  return {
    id: `label-${leafName}`,
    connected_google_account_id: account.id,
    parent_id: options.parentId ?? null,
    depth: options.depth ?? 1,
    leaf_name: leafName,
    full_path: `MailMind/${path}`,
    normalized_name: leafName.toLowerCase().replace(/[^a-z0-9]/g, ''),
    rationale: null,
    source: 'USER_CREATED' as const,
    gmail_label_id: options.gmailLabelId === undefined ? 'Label_1' : options.gmailLabelId,
    created_at: new Date('2026-07-31T00:00:00.000Z'),
    updated_at: new Date('2026-07-31T00:00:00.000Z'),
  };
}

const planner: TaxonomyPlanner = { plan: vi.fn() };

/** The activity record is exercised in its own suite; here it only has to not touch a database. */
function activityStub() {
  return {
    start: vi.fn().mockResolvedValue({
      runId: '00000000-0000-4000-8000-0000000000ff',
      state: 'RUNNING',
      kind: 'LABEL_PROPOSAL',
      startedAt: '2026-08-20T00:00:00.000Z',
      alreadyRunning: false,
    }),
    finishRun: vi.fn().mockResolvedValue(undefined),
  };
}

function service(gmail = { ensureLabel: vi.fn(), applyLabel: vi.fn(), renameLabel: vi.fn() }) {
  const activity = activityStub();
  return {
    instance: new LabelsService(
      mocks as unknown as LabelsRepository,
      gmail as unknown as ConstructorParameters<typeof LabelsService>[1],
      planner,
      activity as unknown as ConstructorParameters<typeof LabelsService>[3],
    ),
    gmail,
    activity,
  };
}

describe('LabelsService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.activeAccountForUser.mockResolvedValue(account);
    mocks.approvedLabels.mockResolvedValue([]);
    mocks.pendingPlan.mockResolvedValue(null);
    mocks.acquireProposalLease.mockResolvedValue({ accountId: account.id, token: 'token' });
    mocks.releaseProposalLease.mockResolvedValue(undefined);
    mocks.markPlanApproved.mockResolvedValue(undefined);
    mocks.replacePlannerRules.mockResolvedValue(0);
    mocks.descendantsOf.mockResolvedValue([]);
    mocks.createLabel.mockImplementation(({ name }: { name: string }) =>
      Promise.resolve(label(name, { gmailLabelId: null })),
    );
    mocks.setGmailLabelId.mockResolvedValue(label('Money in'));
  });

  it('rejects a generic label name', async () => {
    const { instance } = service();
    await expect(
      instance.confirm('user-1', [{ leafName: 'Notifications', source: 'USER_CREATED' }]),
    ).rejects.toMatchObject({ code: 'LABEL_NAME_INVALID', statusCode: 400 });
    expect(mocks.createLabel).not.toHaveBeenCalled();
  });

  it('rejects a name containing a path separator', async () => {
    const { instance } = service();
    await expect(
      instance.confirm('user-1', [{ leafName: 'Work/Invoices', source: 'USER_CREATED' }]),
    ).rejects.toMatchObject({ code: 'LABEL_NAME_INVALID' });
  });

  it('rejects two similar names in the same confirmation with 409', async () => {
    const { instance } = service();
    await expect(
      instance.confirm('user-1', [
        { leafName: 'Invoices', source: 'AI_PROPOSED' },
        { leafName: 'Invoice', source: 'USER_CREATED' },
      ]),
    ).rejects.toMatchObject({ code: 'LABEL_DUPLICATE', statusCode: 409 });
    expect(mocks.createLabel).not.toHaveBeenCalled();
  });

  it('creates a manual label in Gmail and stores the returned id', async () => {
    const gmail = {
      ensureLabel: vi.fn().mockResolvedValue({ id: 'Label_9', created: true }),
      applyLabel: vi.fn(),
      renameLabel: vi.fn(),
    };
    const { instance } = service(gmail);

    await instance.confirm('user-1', [{ leafName: 'Money in', source: 'AI_PROPOSED' }]);

    expect(gmail.ensureLabel).toHaveBeenCalledWith(account.id, 'MailMind/Money in');
    expect(mocks.setGmailLabelId).toHaveBeenCalledWith('label-Money in', 'Label_9');
  });

  it('nests a manual label under its parent and refuses a fourth level', async () => {
    const parent = label('Job hunt');
    mocks.labelForAccount.mockResolvedValue(parent);
    const gmail = {
      ensureLabel: vi.fn().mockResolvedValue({ id: 'Label_9', created: true }),
      applyLabel: vi.fn(),
      renameLabel: vi.fn(),
    };
    const { instance } = service(gmail);

    await instance.confirm('user-1', [
      { leafName: 'Money in', parentId: parent.id, source: 'USER_CREATED' },
    ]);
    expect(mocks.createLabel).toHaveBeenCalledWith(
      expect.objectContaining({ treePath: 'Job hunt/Money in', depth: 2, parentId: parent.id }),
    );

    mocks.labelForAccount.mockResolvedValue(label('Deep', { depth: 3, path: 'a/b/Deep' }));
    await expect(
      instance.confirm('user-1', [
        { leafName: 'Too deep', parentId: 'label-Deep', source: 'USER_CREATED' },
      ]),
    ).rejects.toMatchObject({ code: 'LABEL_NAME_INVALID' });
  });

  it('reuses an already approved label instead of creating a duplicate', async () => {
    mocks.approvedLabels.mockResolvedValue([label('Money in')]);
    const gmail = { ensureLabel: vi.fn(), applyLabel: vi.fn(), renameLabel: vi.fn() };
    const { instance } = service(gmail);

    await instance.confirm('user-1', [{ leafName: 'Money in', source: 'AI_PROPOSED' }]);

    expect(mocks.createLabel).not.toHaveBeenCalled();
    expect(gmail.ensureLabel).not.toHaveBeenCalled();
  });

  it('renames every Gmail label beneath the folder it renames', async () => {
    const parent = label('Job hunt');
    const child = label('Applications sent', {
      depth: 2,
      parentId: parent.id,
      path: 'Job hunt/Applications sent',
      gmailLabelId: 'Label_child',
    });
    mocks.labelForAccount.mockResolvedValue(parent);
    mocks.descendantsOf.mockResolvedValue([child]);
    mocks.approvedLabels.mockResolvedValue([parent, child, label('Money in')]);
    mocks.renameLabel.mockResolvedValue([label('Job search'), child]);
    const gmail = { ensureLabel: vi.fn(), applyLabel: vi.fn(), renameLabel: vi.fn() };
    const { instance } = service(gmail);

    await instance.rename('user-1', parent.id, 'Job search');

    expect(gmail.renameLabel).toHaveBeenCalledWith(account.id, 'Label_1', 'MailMind/Job search');
    expect(gmail.renameLabel).toHaveBeenCalledWith(
      account.id,
      'Label_child',
      'MailMind/Job search/Applications sent',
    );

    await expect(instance.rename('user-1', parent.id, 'Money in')).rejects.toMatchObject({
      code: 'LABEL_DUPLICATE',
      statusCode: 409,
    });
  });

  it('deletes the MailMind record and leaves the Gmail label alone', async () => {
    mocks.labelForAccount.mockResolvedValue(label('Money in'));
    mocks.deleteLabel.mockResolvedValue(label('Money in'));
    const gmail = { ensureLabel: vi.fn(), applyLabel: vi.fn(), renameLabel: vi.fn() };
    const { instance } = service(gmail);

    await expect(instance.remove('user-1', 'label-Money in')).resolves.toMatchObject({
      success: true,
      gmailLabelRetained: true,
      removedDescendants: 0,
    });
    expect(mocks.deleteLabel).toHaveBeenCalledWith('label-Money in');
  });

  it('releases the proposal lease even when there is too little mail', async () => {
    mocks.eligibleMessages.mockResolvedValue([]);
    mocks.existingGmailLabelNames.mockResolvedValue([]);
    const { instance } = service();

    await expect(instance.propose('user-1')).rejects.toMatchObject({
      code: 'LABEL_PROPOSAL_NOT_ENOUGH_MAIL',
      statusCode: 422,
    });
    expect(mocks.releaseProposalLease).toHaveBeenCalledWith({
      accountId: account.id,
      token: 'token',
    });
    expect(planner.plan).not.toHaveBeenCalled();
  });

  it('releases the proposal lease when the planner fails', async () => {
    mocks.eligibleMessages.mockResolvedValue(
      Array.from({ length: 10 }, (_, index) => ({
        id: `m-${index}`,
        subject: 'Subject',
        sender_name: 'Sender',
        sender_email: 'someone@example.com',
        internal_date: new Date(),
      })),
    );
    mocks.existingGmailLabelNames.mockResolvedValue([]);
    vi.mocked(planner.plan).mockRejectedValue(new Error('provider down'));
    const { instance } = service();

    await expect(instance.propose('user-1')).rejects.toThrow('provider down');
    expect(mocks.releaseProposalLease).toHaveBeenCalled();
    expect(mocks.storePlan).not.toHaveBeenCalled();
  });

  it('refuses to approve a plan that would exceed the folder cap', async () => {
    const { env } = await import('../src/config/env.js');
    mocks.approvedLabels.mockResolvedValue(
      Array.from({ length: env.AUTOMATION_MAX_LABELS }, (_, index) => label(`Label ${index}`)),
    );
    mocks.planForAccount.mockResolvedValue({
      id: 'plan-1',
      status: 'PENDING',
      nodes: [
        {
          id: 'node-1',
          parent_id: null,
          depth: 1,
          name: 'One more',
          full_path: 'MailMind/One more',
          rationale: 'because',
          is_leaf: true,
          rules: [],
        },
      ],
    });
    const { instance } = service();

    await expect(instance.approvePlan('user-1', { planId: 'plan-1' })).rejects.toMatchObject({
      code: 'LABEL_LIMIT_REACHED',
      statusCode: 409,
    });
    expect(mocks.createLabel).not.toHaveBeenCalled();
  });

  it('reports a plan that does not belong to the account as missing', async () => {
    mocks.planForAccount.mockResolvedValue(null);
    const { instance } = service();

    await expect(instance.approvePlan('user-1', { planId: 'plan-1' })).rejects.toMatchObject({
      code: 'LABEL_PLAN_NOT_FOUND',
      statusCode: 404,
    });
  });
});
