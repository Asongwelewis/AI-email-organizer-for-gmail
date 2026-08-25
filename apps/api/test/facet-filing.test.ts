import { readFile } from 'node:fs/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  stateUpsert: vi.fn(),
  stateUpdateMany: vi.fn(),
  pivotSettingsUpsert: vi.fn(),
  facetFindMany: vi.fn(),
  gmailLabelFindMany: vi.fn(),
  userLabelFindMany: vi.fn(),
  actionUpsert: vi.fn(),
  runCreate: vi.fn(),
  runUpdate: vi.fn(),
  messageUpdate: vi.fn(),
  messageFindUnique: vi.fn(),
  ensureLabel: vi.fn(),
  applyExclusiveLabel: vi.fn(),
}));

vi.mock('../src/config/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  safeErrorDetails: () => ({}),
}));

vi.mock('../src/database/prisma.js', () => ({
  prisma: {
    automation_states: { upsert: mocks.stateUpsert, updateMany: mocks.stateUpdateMany },
    facet_pivot_settings: { upsert: mocks.pivotSettingsUpsert },
    message_facets: { findMany: mocks.facetFindMany },
    gmail_labels: { findMany: mocks.gmailLabelFindMany },
    user_labels: { findMany: mocks.userLabelFindMany },
    automation_message_actions: { upsert: mocks.actionUpsert },
    automation_runs: { create: mocks.runCreate, update: mocks.runUpdate },
    gmail_message_metadata: { update: mocks.messageUpdate, findUnique: mocks.messageFindUnique },
  },
}));

const filing = await import('../src/features/automation/facet-filing.service.js');
const { FacetFilingService, filingConfidence } = filing;
const { PivotService } = await import('../src/features/labels/pivot.service.js');

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const STALE_LABEL = 'Label_old_tree';

function facetRow(input: {
  id: string;
  entity: string | null;
  intent: string | null;
  intentConfidence?: number | null;
  source?: 'RULE' | 'MODEL';
  labelIds?: string[];
}) {
  return {
    gmail_message_id: input.id,
    entity: input.entity,
    domain: 'entertainment',
    intent: input.intent,
    entity_confidence: 1,
    domain_confidence: 0.9,
    intent_confidence: input.intentConfidence === undefined ? 0.95 : input.intentConfidence,
    source: input.source ?? 'MODEL',
    message: {
      id: input.id,
      gmail_message_id: `g-${input.id}`,
      label_ids: input.labelIds ?? [],
      subject: 'A subject',
    },
  };
}

/** Enough Netflix mail to clear the five-message floor, so a folder actually exists. */
function netflixMailbox(overrides: ReturnType<typeof facetRow>[] = []) {
  return [
    ...Array.from({ length: 6 }, (_, index) =>
      facetRow({ id: `n${index}`, entity: 'netflix', intent: 'payment-failed' }),
    ),
    ...overrides,
  ];
}

function service() {
  const gmail = {
    ensureLabel: mocks.ensureLabel,
    applyExclusiveLabel: mocks.applyExclusiveLabel,
    applyLabel: vi.fn(),
    renameLabel: vi.fn(),
  };
  return new FacetFilingService(gmail as never, new PivotService(gmail as never));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stateUpsert.mockResolvedValue({});
  mocks.stateUpdateMany.mockResolvedValue({ count: 1 });
  mocks.pivotSettingsUpsert.mockResolvedValue({
    canonical_pivot: ['entity', 'intent'],
    min_messages: 5,
  });
  mocks.gmailLabelFindMany.mockResolvedValue([{ gmail_label_id: STALE_LABEL }]);
  mocks.userLabelFindMany.mockResolvedValue([]);
  mocks.actionUpsert.mockResolvedValue({});
  mocks.runCreate.mockResolvedValue({ id: 'run-1' });
  mocks.runUpdate.mockResolvedValue({});
  mocks.messageUpdate.mockResolvedValue({});
  mocks.messageFindUnique.mockResolvedValue({ label_ids: [] });
  mocks.ensureLabel.mockResolvedValue({ id: 'Label_new', created: false });
  mocks.applyExclusiveLabel.mockResolvedValue(undefined);
  mocks.facetFindMany.mockResolvedValue([]);
});

describe('filing confidence', () => {
  it('counts only the facets the message was actually placed by', () => {
    const confidences = { entity: 1, domain: 0.2, intent: 0.99 };
    // Placed at depth 1 under [entity, intent]: only the entity decided where it went.
    expect(filingConfidence(['entity', 'intent'], 1, confidences)).toBe(1);
    // Placed at depth 2: the intent decided the leaf, so it counts.
    expect(filingConfidence(['entity', 'intent'], 2, confidences)).toBe(0.99);
    // A domain-first pivot rests on the domain, and its weakness shows.
    expect(filingConfidence(['domain', 'intent'], 2, confidences)).toBeCloseTo(0.2);
  });

  it('takes the weakest facet, not the average', () => {
    expect(
      filingConfidence(['domain', 'intent'], 2, { entity: 1, domain: 0.99, intent: 0.4 }),
    ).toBe(0.4);
  });
});

/**
 * The claim that makes re-filing cheap: the classification is already stored, so projecting it
 * onto Gmail spends no tokens and asks nothing of a model. Changing a pivot or a threshold has to
 * cost Gmail calls and nothing else — a re-classification would put the whole mailbox back
 * through the daily budget every time a folder threshold moved.
 */
describe('filing and the model', () => {
  it('imports nothing it could reach a model through', async () => {
    const source = await readFile(
      new URL('../src/features/automation/facet-filing.service.ts', import.meta.url),
      'utf8',
    );
    const imports = [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)';/gm)];
    expect(imports.length).toBeGreaterThan(0);

    const modelImports = imports
      .filter(([, typeOnly]) => !typeOnly)
      .map(([, , specifier]) => specifier!)
      .filter((specifier) => /gemini|classifier|classification/i.test(specifier));
    expect(modelImports).toEqual([]);
  });
});

describe('filing mail into pivot folders', () => {
  it('files a message into its leaf and reuses the existing label', async () => {
    mocks.facetFindMany.mockResolvedValue(netflixMailbox());
    const result = await service().fileAccount(ACCOUNT, USER, {});
    expect(result.filed).toBe(6);
    expect(result.none).toBe(0);
    expect(mocks.ensureLabel).toHaveBeenCalledWith(ACCOUNT, 'MailMind/Netflix/Payment failed');
    expect(result.labelsReused).toBe(6);
  });

  it('removes the label the previous tree left behind, in the same call', async () => {
    mocks.facetFindMany.mockResolvedValue(
      netflixMailbox().map((row, index) =>
        index === 0 ? { ...row, message: { ...row.message, label_ids: [STALE_LABEL] } } : row,
      ),
    );
    const result = await service().fileAccount(ACCOUNT, USER, {});
    expect(result.staleLabelsRemoved).toBe(1);
    // One modify: add the new label and drop the old one. Never two calls, so the message is
    // never briefly in both folders or in neither.
    expect(mocks.applyExclusiveLabel).toHaveBeenCalledWith(ACCOUNT, 'g-n0', 'Label_new', [
      STALE_LABEL,
    ]);
  });

  it('leaves a message in the inbox when it fits no folder, and strips its old label', async () => {
    mocks.facetFindMany.mockResolvedValue(
      netflixMailbox([
        facetRow({
          id: 'orphan',
          entity: 'tinyvendor',
          intent: 'invoice-receipt',
          labelIds: [STALE_LABEL],
        }),
      ]),
    );
    const result = await service().fileAccount(ACCOUNT, USER, {});
    expect(result.none).toBe(1);
    expect(mocks.applyExclusiveLabel).toHaveBeenCalledWith(ACCOUNT, 'g-orphan', null, [
      STALE_LABEL,
    ]);
    const noneWrite = mocks.actionUpsert.mock.calls.find(
      (call) => call[0].where.gmail_message_id === 'orphan',
    )!;
    expect(noneWrite[0].create).toMatchObject({ label_name: 'NONE', label_path: null });
  });

  it('holds a low-confidence decision for review without touching Gmail', async () => {
    mocks.facetFindMany.mockResolvedValue(
      netflixMailbox().map((row, index) =>
        index === 0 ? { ...row, intent_confidence: 0.4 } : row,
      ),
    );
    const result = await service().fileAccount(ACCOUNT, USER, {});
    expect(result.reviewRequired).toBe(1);
    expect(result.filed).toBe(5);
    const held = mocks.actionUpsert.mock.calls.find(
      (call) => call[0].where.gmail_message_id === 'n0',
    )!;
    expect(held[0].create).toMatchObject({
      status: 'REVIEW_REQUIRED',
      label_path: 'MailMind/Netflix/Payment failed',
    });
    expect(mocks.applyExclusiveLabel).not.toHaveBeenCalledWith(
      ACCOUNT,
      'g-n0',
      expect.anything(),
      expect.anything(),
    );
  });

  it('counts every decision and writes nothing at all in a dry run', async () => {
    mocks.facetFindMany.mockResolvedValue(
      netflixMailbox([facetRow({ id: 'orphan', entity: 'tinyvendor', intent: 'invoice-receipt' })]),
    );
    const result = await service().fileAccount(ACCOUNT, USER, { dryRun: true });
    expect(result.filed).toBe(6);
    expect(result.none).toBe(1);
    expect(mocks.ensureLabel).not.toHaveBeenCalled();
    expect(mocks.applyExclusiveLabel).not.toHaveBeenCalled();
    // Not even the decision rows: a dry run must not leave the database claiming mail was filed
    // that carries no label in the mailbox.
    expect(mocks.actionUpsert).not.toHaveBeenCalled();
    expect(mocks.runCreate).not.toHaveBeenCalled();
  });

  it('separates decisions that came from rules from those that came from the model', async () => {
    mocks.facetFindMany.mockResolvedValue(
      netflixMailbox().map((row, index) => (index < 2 ? { ...row, source: 'RULE' as const } : row)),
    );
    const result = await service().fileAccount(ACCOUNT, USER, { dryRun: true });
    expect(result.fromRules).toBe(2);
    expect(result.fromModel).toBe(4);
  });

  it('refuses to run while the account is already leased', async () => {
    mocks.stateUpdateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service().fileAccount(ACCOUNT, USER, {})).rejects.toMatchObject({
      code: 'AUTOMATION_ALREADY_RUNNING',
    });
  });

  it('refuses to file when the pivot produced no folders at all', async () => {
    mocks.facetFindMany.mockResolvedValue([facetRow({ id: 'a', entity: null, intent: null })]);
    await expect(service().fileAccount(ACCOUNT, USER, {})).rejects.toMatchObject({
      code: 'AUTOMATION_NO_APPROVED_LABELS',
    });
  });
});
