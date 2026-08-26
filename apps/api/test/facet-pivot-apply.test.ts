import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pivotSettingsUpsert: vi.fn(),
  facetFindMany: vi.fn(),
  facetCount: vi.fn(),
  gmailLabelFindMany: vi.fn(),
  userLabelFindMany: vi.fn(),
  userLabelUpsert: vi.fn(),
  userLabelUpdate: vi.fn(),
  userLabelUpdateMany: vi.fn(),
  userLabelDelete: vi.fn(),
  userLabelDeleteMany: vi.fn(),
  auditRecord: vi.fn(),
  ensureLabel: vi.fn(),
  renameLabel: vi.fn(),
}));

vi.mock('../src/config/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  safeErrorDetails: () => ({}),
}));
vi.mock('../src/audit/audit.service.js', () => ({
  auditService: { record: mocks.auditRecord },
}));
vi.mock('../src/database/prisma.js', () => ({
  prisma: {
    facet_pivot_settings: { upsert: mocks.pivotSettingsUpsert },
    message_facets: { findMany: mocks.facetFindMany, count: mocks.facetCount },
    gmail_labels: { findMany: mocks.gmailLabelFindMany },
    user_labels: {
      findMany: mocks.userLabelFindMany,
      upsert: mocks.userLabelUpsert,
      update: mocks.userLabelUpdate,
      updateMany: mocks.userLabelUpdateMany,
      delete: mocks.userLabelDelete,
      deleteMany: mocks.userLabelDeleteMany,
    },
  },
}));

const { PivotService } = await import('../src/features/labels/pivot.service.js');

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

function facetRow(id: string, entity: string, intent: string) {
  return {
    gmail_message_id: id,
    entity,
    domain: 'entertainment',
    intent,
    entity_confidence: 1,
    domain_confidence: 0.9,
    intent_confidence: 0.95,
    source: 'MODEL',
    message: { id, gmail_message_id: `g-${id}`, label_ids: [], subject: 'A subject' },
  };
}

/** Enough of one brand's mail to clear the floor, so the pivot actually produces folders. */
function netflixMail(count = 6) {
  return Array.from({ length: count }, (_, index) =>
    facetRow(`n${index}`, 'netflix', 'payment-failed'),
  );
}

function existingFolder(input: {
  id: string;
  path: string;
  depth: number;
  facetKey: string | null;
  gmailLabelId?: string | null;
  parentId?: string | null;
}) {
  return {
    id: input.id,
    connected_google_account_id: ACCOUNT,
    parent_id: input.parentId ?? null,
    depth: input.depth,
    leaf_name: input.path.split('/').at(-1)!,
    full_path: input.path,
    normalized_name: input.path.split('/').at(-1)!.toLowerCase(),
    facet_key: input.facetKey,
    gmail_label_id: input.gmailLabelId ?? null,
    source: 'AI_PROPOSED',
  };
}

/**
 * The whole tree the default `[entity, intent]` pivot produces for this mailbox, already
 * materialised. `spelling` renders the brand however the account happens to spell it today; only
 * the leaf carries a Gmail label, because a branch is a container in the tree and nothing at all
 * in the mailbox.
 */
function materialisedTree(spelling = 'Netflix') {
  return [
    existingFolder({
      id: 'row-netflix',
      path: `MailMind/${spelling}`,
      depth: 1,
      facetKey: 'entity=netflix',
    }),
    existingFolder({
      id: 'row-payment-failed',
      path: `MailMind/${spelling}/Payment failed`,
      depth: 2,
      parentId: 'row-netflix',
      facetKey: 'entity=netflix|intent=payment-failed',
      gmailLabelId: 'Label_payment_failed',
    }),
  ];
}

function service() {
  const gmail = {
    ensureLabel: mocks.ensureLabel,
    renameLabel: mocks.renameLabel,
    applyLabel: vi.fn(),
    applyExclusiveLabel: vi.fn(),
  };
  return new PivotService(gmail as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pivotSettingsUpsert.mockResolvedValue({
    canonical_pivot: ['entity', 'intent'],
    min_messages: 5,
  });
  mocks.facetFindMany.mockResolvedValue(netflixMail());
  mocks.facetCount.mockResolvedValue(0);
  mocks.gmailLabelFindMany.mockResolvedValue([]);
  mocks.userLabelFindMany.mockResolvedValue([]);
  mocks.userLabelUpsert.mockImplementation(async ({ create }: { create: { full_path: string } }) =>
    existingFolder({
      id: `new-${create.full_path}`,
      path: create.full_path,
      depth: 1,
      facetKey: null,
    }),
  );
  mocks.userLabelUpdate.mockImplementation(async ({ where }: { where: { id: string } }) =>
    existingFolder({ id: where.id, path: 'MailMind/Netflix', depth: 1, facetKey: null }),
  );
  mocks.userLabelUpdateMany.mockResolvedValue({ count: 1 });
  mocks.ensureLabel.mockResolvedValue({ id: 'Label_new', created: true });
  mocks.auditRecord.mockResolvedValue(undefined);
});

/**
 * A folder is a view of a facet combination, and `facet_key` is which combination — the path is
 * only how that combination happens to be spelled today. Everything here is about the difference
 * between those two, because writing by path is what quietly turns one folder into two.
 */
describe('applying the canonical pivot', () => {
  it('creates a folder for a combination nothing has materialised yet', async () => {
    const result = await service().apply(ACCOUNT, USER);

    expect(result.rowsCreated).toBeGreaterThan(0);
    expect(result.rowsKept).toBe(0);
    const created = mocks.userLabelUpsert.mock.calls.map((call) => call[0].create.facet_key);
    expect(created).toContain('entity=netflix');
    // Only leaves reach Gmail: nesting there is cosmetic and a branch is a container in the tree.
    for (const call of mocks.ensureLabel.mock.calls) {
      expect(call[1]).toMatch(/^MailMind\//);
    }
  });

  // The claim the card makes in as many words: re-applying keeps the row and its Gmail label.
  it('keeps an existing row and its Gmail label rather than recreating either', async () => {
    mocks.userLabelFindMany.mockResolvedValue(materialisedTree());
    mocks.ensureLabel.mockResolvedValue({ id: 'Label_payment_failed', created: false });

    const result = await service().apply(ACCOUNT, USER);

    expect(result.rowsKept).toBe(2);
    expect(result.rowsCreated).toBe(0);
    expect(result.gmailLabelsCreated).toBe(0);
    expect(result.gmailLabelsReused).toBe(1);
    expect(mocks.userLabelUpsert).not.toHaveBeenCalled();
    expect(mocks.userLabelUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'row-netflix' } }),
    );
    // Nothing was renamed, so the spelling never reached Gmail at all.
    expect(mocks.renameLabel).not.toHaveBeenCalled();
  });

  /**
   * The bug this test was written for. `apply` used to write by `full_path`, so the first time a
   * value's spelling changed it would try to INSERT a second row carrying a facet key another row
   * already held — and the partial unique index on (account, facet_key) failed the whole apply.
   * A folder is allowed to survive being spelled differently; that is what makes the key the
   * identity and the path a rendering of it.
   */
  it('follows a folder through a change in how its value is spelled', async () => {
    // The same tree, spelled the way it was before the brand's spelling was corrected.
    mocks.userLabelFindMany.mockResolvedValue(materialisedTree('netflix'));
    mocks.ensureLabel.mockResolvedValue({ id: 'Label_payment_failed', created: false });

    const result = await service().apply(ACCOUNT, USER);

    // Rows updated in place onto the new spelling. Never a second insert carrying the same key.
    expect(mocks.userLabelUpsert).not.toHaveBeenCalled();
    expect(result.rowsKept).toBe(2);
    const parent = mocks.userLabelUpdate.mock.calls[0]![0];
    expect(parent.where).toEqual({ id: 'row-netflix' });
    expect(parent.data.full_path).toBe('MailMind/Netflix');
    expect(parent.data.leaf_name).toBe('Netflix');

    // And the Gmail label is renamed, not replaced. A second label at the new spelling would
    // strand every message still sitting under the old one, because deleting a label never
    // unlabels its mail.
    expect(mocks.renameLabel).toHaveBeenCalledWith(
      ACCOUNT,
      'Label_payment_failed',
      'MailMind/Netflix/Payment failed',
    );
    expect(result.gmailLabelsRenamed).toBe(1);
    expect(result.gmailLabelsCreated).toBe(0);
  });

  // Deleting a Gmail label does not unlabel the mail beneath it, so removing a folder is a
  // decision for a person rather than a side effect of re-running a pivot.
  it('reports a folder that matches no current combination and leaves it alone', async () => {
    mocks.userLabelFindMany.mockResolvedValue([
      existingFolder({
        id: 'row-gone',
        path: 'MailMind/Finance/Transactions/Failed payments',
        depth: 1,
        facetKey: 'entity=someonewholeft',
        gmailLabelId: 'Label_planner_era',
      }),
    ]);

    const result = await service().apply(ACCOUNT, USER);

    expect(result.orphaned).toEqual([
      {
        id: 'row-gone',
        fullPath: 'MailMind/Finance/Transactions/Failed payments',
        gmailLabelId: 'Label_planner_era',
      },
    ]);
    expect(mocks.userLabelDelete).not.toHaveBeenCalled();
    expect(mocks.userLabelDeleteMany).not.toHaveBeenCalled();
    expect(mocks.auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'labels.pivot.applied',
        metadata: expect.objectContaining({ orphanedLeftAlone: 1 }),
      }),
    );
  });

  // A folder the tree planner created carries no facet key at all, so it is matched by path —
  // otherwise the pivot would create a second Gmail label over mail that already has one.
  it('adopts a planner-era folder by path when it has no facet key', async () => {
    mocks.userLabelFindMany.mockResolvedValue([
      existingFolder({
        id: 'row-planner',
        path: 'MailMind/Netflix',
        depth: 1,
        facetKey: null,
        gmailLabelId: 'Label_planner_netflix',
      }),
    ]);
    mocks.ensureLabel.mockResolvedValue({ id: 'Label_planner_netflix', created: false });

    const result = await service().apply(ACCOUNT, USER);

    expect(result.orphaned).toEqual([]);
    expect(result.rowsKept).toBeGreaterThan(0);
    // Matched by path, so the write is the path-keyed upsert that stamps the facet key on.
    expect(mocks.userLabelUpsert.mock.calls[0]![0].update.facet_key).toBe('entity=netflix');
    expect(result.gmailLabelsCreated).toBe(0);
  });
});

describe('the orderings that are never materialised', () => {
  it('answers a different ordering without writing or calling Gmail', async () => {
    const view = await service().view(ACCOUNT, ['domain', 'intent', 'entity']);

    expect(view.order).toEqual(['domain', 'intent', 'entity']);
    expect(view.nodes.length).toBeGreaterThan(0);
    expect(mocks.ensureLabel).not.toHaveBeenCalled();
    expect(mocks.renameLabel).not.toHaveBeenCalled();
    expect(mocks.userLabelUpsert).not.toHaveBeenCalled();
    expect(mocks.userLabelUpdate).not.toHaveBeenCalled();
  });

  // The same mail, reordered. Nothing about any message is recomputed to answer this.
  it('arranges the same mail two ways from one set of facet rows', async () => {
    const entityFirst = await service().view(ACCOUNT, ['entity', 'intent']);
    const domainFirst = await service().view(ACCOUNT, ['domain', 'intent', 'entity']);

    expect(entityFirst.nodes.find((node) => node.depth === 1)?.leafName).toBe('Netflix');
    expect(domainFirst.nodes.find((node) => node.depth === 1)?.leafName).toBe('Entertainment');
    expect(mocks.facetFindMany).toHaveBeenCalledTimes(2);
    expect(mocks.ensureLabel).not.toHaveBeenCalled();
  });

  it('plans without writing anything at all', async () => {
    const plan = await service().plan(ACCOUNT);

    expect(plan.changes.length).toBeGreaterThan(0);
    expect(mocks.userLabelUpsert).not.toHaveBeenCalled();
    expect(mocks.userLabelUpdate).not.toHaveBeenCalled();
    expect(mocks.ensureLabel).not.toHaveBeenCalled();
    expect(mocks.auditRecord).not.toHaveBeenCalled();
  });
});

/**
 * The folder view reads facets directly. It must work with no `user_labels` row and with no
 * `apply` ever having run — that is what makes the PWA the folder view rather than a reflection
 * of what was written to Gmail.
 */
describe('the mail inside a folder', () => {
  const row = (id: string) => ({
    gmail_message_id: id,
    entity: 'netflix',
    domain: 'entertainment',
    intent: 'payment-failed',
    message: {
      gmail_message_id: `g-${id}`,
      subject: 'Your payment could not be processed',
      sender_name: 'Netflix',
      sender_email: 'info@netflix.com',
      snippet: 'We were unable to charge your card.',
      internal_date: new Date('2026-08-20T00:00:00.000Z'),
      is_unread: true,
    },
  });

  it('constrains on exactly the facets the key names', async () => {
    mocks.facetFindMany.mockResolvedValue([row('a')]);
    mocks.facetCount.mockResolvedValue(1);

    const result = await service().folderMessages(ACCOUNT, 'entity=netflix|intent=payment-failed');

    expect(mocks.facetFindMany.mock.calls[0]![0].where).toMatchObject({
      connected_google_account_id: ACCOUNT,
      entity: 'netflix',
      intent: 'payment-failed',
    });
    // Newest first, and by id after that so a cursor never straddles two messages that arrived
    // in the same second.
    expect(mocks.facetFindMany.mock.calls[0]![0].orderBy).toEqual([
      { message: { internal_date: 'desc' } },
      { gmail_message_id: 'desc' },
    ]);
    expect(result.messages[0]).toMatchObject({
      gmailMessageId: 'g-a',
      subject: 'Your payment could not be processed',
    });
  });

  // Opening a parent asks "everything under here", which is a different question from where the
  // pivot placed each message. `entity=netflix` must not silently also filter by intent.
  it('reads a parent folder as its whole subtree', async () => {
    mocks.facetFindMany.mockResolvedValue([row('a')]);
    mocks.facetCount.mockResolvedValue(1);

    await service().folderMessages(ACCOUNT, 'entity=netflix');

    const where = mocks.facetFindMany.mock.calls[0]![0].where;
    expect(where.entity).toBe('netflix');
    expect(where).not.toHaveProperty('intent');
    expect(where).not.toHaveProperty('domain');
  });

  /**
   * A key that constrains nothing would leave the where clause as the account alone and hand back
   * the entire mailbox under one folder heading.
   */
  it('refuses a key that constrains nothing', async () => {
    for (const key of ['', 'sender=netflix', 'notafacet=x']) {
      await expect(service().folderMessages(ACCOUNT, key)).rejects.toMatchObject({
        code: 'LABEL_VALIDATION_FAILED',
      });
    }
    expect(mocks.facetFindMany).not.toHaveBeenCalled();
  });

  // One combination in the real mailbox holds 1,823 messages, so a folder has to page.
  it('hands back a cursor only while there is another page', async () => {
    mocks.facetCount.mockResolvedValue(3);
    mocks.facetFindMany.mockResolvedValue([row('a'), row('b'), row('c')]);

    const full = await service().folderMessages(ACCOUNT, 'entity=netflix', { limit: 2 });
    expect(full.messages).toHaveLength(2);
    expect(full.nextCursor).toBe('b');
    expect(full.total).toBe(3);

    mocks.facetFindMany.mockResolvedValue([row('a')]);
    const last = await service().folderMessages(ACCOUNT, 'entity=netflix', { limit: 2 });
    expect(last.nextCursor).toBeNull();
  });
});
