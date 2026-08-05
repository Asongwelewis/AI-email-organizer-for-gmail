import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auditRecord: vi.fn(),
  activeAccountForUser: vi.fn(),
  approvedLabels: vi.fn(),
  pendingProposals: vi.fn(),
  acquireProposalLease: vi.fn(),
  releaseProposalLease: vi.fn(),
  eligibleMessages: vi.fn(),
  existingGmailLabelNames: vi.fn(),
  clearPendingProposals: vi.fn(),
  storeProposal: vi.fn(),
  createLabel: vi.fn(),
  setGmailLabelId: vi.fn(),
  renameLabel: vi.fn(),
  deleteLabel: vi.fn(),
  labelForAccount: vi.fn(),
  markProposalsApproved: vi.fn(),
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

const account = { id: 'account-1', user_id: 'user-1' };

function label(leafName: string, gmailLabelId: string | null = 'Label_1') {
  return {
    id: `label-${leafName}`,
    connected_google_account_id: account.id,
    leaf_name: leafName,
    full_path: `MailMind/${leafName}`,
    normalized_name: leafName.toLowerCase(),
    source: 'USER_CREATED' as const,
    gmail_label_id: gmailLabelId,
    created_at: new Date('2026-07-31T00:00:00.000Z'),
    updated_at: new Date('2026-07-31T00:00:00.000Z'),
  };
}

function service(gmail = { ensureLabel: vi.fn(), applyLabel: vi.fn(), renameLabel: vi.fn() }) {
  return {
    instance: new LabelsService(
      mocks as unknown as LabelsRepository,
      gmail as unknown as ConstructorParameters<typeof LabelsService>[1],
    ),
    gmail,
  };
}

describe('LabelsService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.activeAccountForUser.mockResolvedValue(account);
    mocks.approvedLabels.mockResolvedValue([]);
    mocks.pendingProposals.mockResolvedValue([]);
    mocks.acquireProposalLease.mockResolvedValue({ accountId: account.id, token: 'token' });
    mocks.releaseProposalLease.mockResolvedValue(undefined);
    mocks.markProposalsApproved.mockResolvedValue(undefined);
    mocks.clearPendingProposals.mockResolvedValue(undefined);
    mocks.createLabel.mockImplementation(({ leafName }: { leafName: string }) =>
      Promise.resolve(label(leafName, null)),
    );
    mocks.setGmailLabelId.mockResolvedValue(label('Invoices'));
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

  it('creates each approved label in Gmail and stores the returned id', async () => {
    const gmail = {
      ensureLabel: vi.fn().mockResolvedValue({ id: 'Label_9', created: true }),
      applyLabel: vi.fn(),
      renameLabel: vi.fn(),
    };
    const { instance } = service(gmail);

    await instance.confirm('user-1', [{ leafName: 'Invoices', source: 'AI_PROPOSED' }]);

    expect(gmail.ensureLabel).toHaveBeenCalledWith(account.id, 'MailMind/Invoices');
    expect(mocks.setGmailLabelId).toHaveBeenCalledWith('label-Invoices', 'Label_9');
    expect(mocks.markProposalsApproved).toHaveBeenCalledWith(account.id, ['Invoices']);
  });

  it('reuses an already approved label instead of creating a duplicate', async () => {
    mocks.approvedLabels.mockResolvedValue([label('Invoices')]);
    const gmail = { ensureLabel: vi.fn(), applyLabel: vi.fn(), renameLabel: vi.fn() };
    const { instance } = service(gmail);

    await instance.confirm('user-1', [{ leafName: 'Invoices', source: 'AI_PROPOSED' }]);

    expect(mocks.createLabel).not.toHaveBeenCalled();
    expect(gmail.ensureLabel).not.toHaveBeenCalled();
  });

  it('renames in Gmail and rejects a rename that collides with another label', async () => {
    mocks.labelForAccount.mockResolvedValue(label('Invoices'));
    mocks.approvedLabels.mockResolvedValue([label('Invoices'), label('Flights')]);
    mocks.renameLabel.mockResolvedValue(label('Bills'));
    const gmail = { ensureLabel: vi.fn(), applyLabel: vi.fn(), renameLabel: vi.fn() };
    const { instance } = service(gmail);

    await instance.rename('user-1', 'label-Invoices', 'Bills');
    expect(gmail.renameLabel).toHaveBeenCalledWith(account.id, 'Label_1', 'MailMind/Bills');

    await expect(instance.rename('user-1', 'label-Invoices', 'Flights')).rejects.toMatchObject({
      code: 'LABEL_DUPLICATE',
      statusCode: 409,
    });
  });

  it('deletes the MailMind record and leaves the Gmail label alone', async () => {
    mocks.labelForAccount.mockResolvedValue(label('Invoices'));
    mocks.deleteLabel.mockResolvedValue(label('Invoices'));
    const gmail = { ensureLabel: vi.fn(), applyLabel: vi.fn(), renameLabel: vi.fn() };
    const { instance } = service(gmail);

    await expect(instance.remove('user-1', 'label-Invoices')).resolves.toMatchObject({
      success: true,
      gmailLabelRetained: true,
    });
    expect(mocks.deleteLabel).toHaveBeenCalledWith('label-Invoices');
  });

  it('refuses to propose past the configured label cap', async () => {
    const { env } = await import('../src/config/env.js');
    mocks.approvedLabels.mockResolvedValue(
      Array.from({ length: env.AUTOMATION_MAX_LABELS }, (_, index) => label(`Label ${index}`)),
    );
    const { instance } = service();

    await expect(instance.propose('user-1')).rejects.toMatchObject({
      code: 'LABEL_LIMIT_REACHED',
      statusCode: 409,
    });
    expect(mocks.acquireProposalLease).not.toHaveBeenCalled();
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
  });
});
