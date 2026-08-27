import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  facetFindMany: vi.fn(),
  facetGroupBy: vi.fn(),
  pivotSettingsUpsert: vi.fn(),
}));

vi.mock('../src/database/prisma.js', () => ({
  prisma: {
    $queryRaw: mocks.queryRaw,
    message_facets: { findMany: mocks.facetFindMany, groupBy: mocks.facetGroupBy },
    facet_pivot_settings: { upsert: mocks.pivotSettingsUpsert },
  },
}));

const { MessageSearchService } = await import('../src/features/facets/message-search.service.js');
const { PivotService } = await import('../src/features/labels/pivot.service.js');
const { APPROVED_FACET_VOCABULARY } = await import('../src/features/label-discovery/facets.js');

const ACCOUNT = '11111111-1111-4111-8111-111111111111';

/**
 * A tagged template reaches a mocked `$queryRaw` as (strings, ...values). Rejoining them with a
 * marker is enough to assert on the shape of the SQL without reimplementing Prisma's builder.
 */
function sqlOf(call: unknown[]): string {
  const [strings, ...values] = call as [string[], ...unknown[]];
  return strings
    .map((part, index) => part + (index < values.length ? sqlOf.render(values[index]) : ''))
    .join('');
}
sqlOf.render = (value: unknown): string => {
  const fragment = value as { strings?: string[]; values?: unknown[] };
  if (Array.isArray(fragment?.strings)) {
    return fragment.strings
      .map((part, index) => part + (index < fragment.values!.length ? '?' : ''))
      .join('');
  }
  return '?';
};

/** Every bound parameter of a call, including the ones nested inside Prisma.sql fragments. */
function valuesOf(call: unknown[]): unknown[] {
  const [, ...values] = call as [string[], ...unknown[]];
  return values.flatMap((value) => {
    const fragment = value as { strings?: string[]; values?: unknown[] };
    return Array.isArray(fragment?.strings) ? (fragment.values ?? []) : [value];
  });
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    gmail_message_id: 'g-1',
    subject: 'Your payment failed',
    sender_name: 'Netflix',
    sender_email: 'billing@netflix.com',
    snippet: null,
    internal_date: new Date('2026-08-01T00:00:00.000Z'),
    is_unread: false,
    entity: 'netflix',
    domain: 'finance',
    intent: 'payment-failed',
    ...overrides,
  };
}

/*
 * A vocabulary belongs to a mailbox now, so the filter options come from the account's approved
 * set rather than a module constant. The checked-in set stands in for one here.
 */
function service() {
  return new MessageSearchService(new PivotService({} as never), {
    approved: async () => APPROVED_FACET_VOCABULARY,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pivotSettingsUpsert.mockResolvedValue({
    canonical_pivot: ['entity', 'intent'],
    min_messages: 1,
  });
  // The mailbox `buildPivot` runs over, so a hit has a folder to be located in.
  mocks.facetFindMany.mockResolvedValue([
    {
      gmail_message_id: 'g-1',
      entity: 'netflix',
      domain: 'finance',
      intent: 'payment-failed',
      message: { is_unread: false },
    },
    {
      gmail_message_id: 'g-2',
      entity: 'netflix',
      domain: 'finance',
      intent: 'payment-failed',
      message: { is_unread: true },
    },
  ]);
  // First call counts, second selects the page, third groups the whole match set by facet
  // combination so the folder breakdown is over every match rather than the page in hand.
  mocks.queryRaw
    .mockResolvedValueOnce([{ total: 1n }])
    .mockResolvedValueOnce([row()])
    .mockResolvedValueOnce([
      { entity: 'netflix', domain: 'finance', intent: 'payment-failed', n: 1n },
    ]);
});

/**
 * Card 24. Folders are half of findability; this is the other half — the message you can only
 * half remember, found across the whole mailbox rather than one folder at a time.
 */
describe('searching the mailbox', () => {
  /**
   * A flat list of messages is a worse mailbox than the one a person already has, so the answer
   * leads with where the mail is. The breakdown is counted over the whole match set rather than
   * the page in hand, or the numbers would climb as more pages loaded.
   */
  it('says which folders hold the matches, counted over all of them', async () => {
    const result = await service().search(ACCOUNT, 'payment failed', {});

    expect(result.folders).toEqual([
      expect.objectContaining({ leafName: 'Payment failed', count: 1 }),
    ]);
  });

  it('finds a message by a fragment of its subject and says which folder it is in', async () => {
    const result = await service().search(ACCOUNT, 'payment failed', {});

    expect(result.total).toBe(1);
    expect(result.results[0]).toMatchObject({
      gmailMessageId: 'g-1',
      subject: 'Your payment failed',
      // Half the answer is "it was under Netflix all along".
      folder: { fullPath: 'MailMind/Netflix/Payment failed', leafName: 'Payment failed' },
    });
  });

  /**
   * `billing@netflix.com` is one `email` token to the text-search parser, so the index splits the
   * address into words. The query side has to split it identically or a pasted address matches
   * nothing — and a bare brand name would never reach the address at all.
   */
  it('splits an address the same way the index does, so a brand matches its sender', async () => {
    await service().search(ACCOUNT, 'billing@netflix.com', {});

    const terms = valuesOf(mocks.queryRaw.mock.calls[0]!).find(
      (value) => typeof value === 'string' && value.includes('netflix'),
    );
    expect(terms).toBe('billing netflix com');
  });

  /**
   * The thing a Gmail label tree genuinely cannot do: one intent across every brand at once. A
   * facet filter constrains the facet row, so it has to be an inner join.
   */
  it('narrows by facet with no phrase at all', async () => {
    await service().search(ACCOUNT, null, { intent: 'payment-failed' });

    const sql = sqlOf(mocks.queryRaw.mock.calls[0]!);
    expect(sql).toContain('join public.message_facets');
    expect(sql).not.toContain('left join public.message_facets');
    expect(valuesOf(mocks.queryRaw.mock.calls[0]!)).toContain('payment-failed');
  });

  /**
   * Mail that has never been classified is exactly the mail somebody is most likely to be hunting
   * for, so a phrase-only search must not require a facet row to exist.
   */
  it('still finds mail that carries no facets when the search is a phrase', async () => {
    await service().search(ACCOUNT, 'invoice', {});

    expect(sqlOf(mocks.queryRaw.mock.calls[0]!)).toContain('left join public.message_facets');
  });

  // Deleted mail is not findable. It is not in the mailbox any more.
  it('leaves deleted mail out', async () => {
    await service().search(ACCOUNT, 'invoice', {});

    expect(sqlOf(mocks.queryRaw.mock.calls[0]!)).toContain('m.deleted_at is null');
  });

  /**
   * "What has arrived that I have not read" is a whole question on its own — no phrase, no facet —
   * and it is the one a person asks most often. Newest first, each hit carrying its folder.
   */
  it('answers unread on its own, with no phrase and no facet', async () => {
    await service().search(ACCOUNT, null, { unread: true });

    const sql = sqlOf(mocks.queryRaw.mock.calls[0]!);
    expect(sql).toContain('m.is_unread = true');
    // No facet filter, so mail that was never classified is still findable.
    expect(sql).toContain('left join public.message_facets');
  });

  /**
   * A search constraining nothing is not a search — it is the mailbox — and answering it under a
   * "results" heading would misrepresent what was found.
   */
  it('refuses a search with neither a phrase nor a facet', async () => {
    await expect(service().search(ACCOUNT, '   ', {})).rejects.toMatchObject({
      code: 'FACET_VALIDATION_FAILED',
      statusCode: 400,
    });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  /**
   * `internal_date` is nullable, and a tuple comparison against a null is null — which would drop
   * every undated message from the second page onwards rather than paging past it.
   */
  it('pages on a key that survives a message with no date', async () => {
    await service().search(ACCOUNT, 'invoice', {}, { cursor: ACCOUNT });

    const sql = sqlOf(mocks.queryRaw.mock.calls[1]!);
    expect(sql).toContain('coalesce(m.internal_date, to_timestamp(0))');
  });

  it('reports another page without counting twice', async () => {
    mocks.queryRaw.mockReset();
    mocks.queryRaw
      .mockResolvedValueOnce([{ total: 3n }])
      .mockResolvedValueOnce([row(), row({ id: 'b' }), row({ id: 'c' })])
      .mockResolvedValueOnce([
        { entity: 'netflix', domain: 'finance', intent: 'payment-failed', n: 3n },
      ]);

    const result = await service().search(ACCOUNT, 'invoice', {}, { limit: 2 });

    expect(result.results).toHaveLength(2);
    expect(result.nextCursor).toBe('b');
  });
});

describe('what there is to filter by', () => {
  beforeEach(() => {
    mocks.facetGroupBy.mockImplementation(async ({ by }: { by: string[] }) => {
      if (by[0] === 'entity') {
        return [
          { entity: 'netflix', _count: { _all: 40 } },
          { entity: 'coursera', _count: { _all: 12 } },
        ];
      }
      if (by[0] === 'domain') return [{ domain: 'finance', _count: { _all: 52 } }];
      return [{ intent: 'payment-failed', _count: { _all: 9 } }];
    });
  });

  it("lists this mailbox's brands, commonest first", async () => {
    const vocabulary = await service().vocabulary(ACCOUNT);

    expect(vocabulary.entity).toEqual([
      { value: 'netflix', messageCount: 40 },
      { value: 'coursera', messageCount: 12 },
    ]);
  });

  /**
   * A filter that hides its own empty options makes the vocabulary look smaller than it is, so
   * every approved value appears — at zero when this mailbox has none of it.
   */
  it('keeps every approved value, including the ones this mailbox has none of', async () => {
    const vocabulary = await service().vocabulary(ACCOUNT);

    expect(vocabulary.domain.find((value) => value.value === 'finance')).toMatchObject({
      messageCount: 52,
    });
    expect(vocabulary.domain.length).toBeGreaterThan(1);
    expect(vocabulary.domain.some((value) => value.messageCount === 0)).toBe(true);
  });
});
