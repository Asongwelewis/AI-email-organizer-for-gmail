import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  deleteMany: vi.fn(),
  createMany: vi.fn(),
  transaction: vi.fn(async (operations: unknown[]) => operations),
}));

vi.mock('../src/database/prisma.js', () => ({
  prisma: {
    facet_vocabularies: {
      findMany: mocks.findMany,
      deleteMany: mocks.deleteMany,
      createMany: mocks.createMany,
    },
    $transaction: mocks.transaction,
  },
}));

const { FacetVocabularyRepository, vocabularyFingerprint } =
  await import('../src/features/label-discovery/facet-vocabulary.repository.js');
const { facetPromptVersion } = await import('../src/features/automation/facet-classifier.js');

const ACCOUNT = '11111111-1111-4111-8111-111111111111';

const row = (facet: string, name: string, definition = 'A definition long enough to pass.') => ({
  facet,
  name,
  definition,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deleteMany.mockResolvedValue({ count: 0 });
  mocks.createMany.mockResolvedValue({ count: 0 });
});

/**
 * Card 28. `facets.ts` holds a set of domains and intents as a checked-in constant, dated to one
 * mailbox owner on one day. It is still correct — for that mailbox. A second user classified
 * against it would be filed into a stranger's taxonomy, and no amount of authentication work
 * changes that, which is why this blocks multi-user structurally rather than incidentally.
 */
describe('the vocabulary a mailbox approved', () => {
  it('reads the approved set for that account and nobody else', async () => {
    mocks.findMany.mockResolvedValue([row('domain', 'finance'), row('intent', 'payment-failed')]);

    const vocabulary = await new FacetVocabularyRepository().approved(ACCOUNT);

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { connected_google_account_id: ACCOUNT, status: 'APPROVED' },
      }),
    );
    expect(vocabulary.domain).toEqual([
      { name: 'finance', definition: 'A definition long enough to pass.' },
    ]);
    expect(vocabulary.intent).toHaveLength(1);
  });

  /**
   * The classifier must never fall back to somebody else's list. Refusing is the same shape as
   * `AUTOMATION_NO_APPROVED_LABELS`: a precondition a person can act on, not a silent default.
   */
  it('refuses rather than defaulting when a mailbox has approved nothing', async () => {
    mocks.findMany.mockResolvedValue([]);

    await expect(new FacetVocabularyRepository().requireApproved(ACCOUNT)).rejects.toMatchObject({
      code: 'FACET_VOCABULARY_NOT_APPROVED',
      statusCode: 409,
    });
  });

  // Half a vocabulary is not a vocabulary: a message needs a value on both axes.
  it('refuses a set with values on only one axis', async () => {
    mocks.findMany.mockResolvedValue([row('domain', 'finance')]);

    await expect(new FacetVocabularyRepository().requireApproved(ACCOUNT)).rejects.toMatchObject({
      code: 'FACET_VOCABULARY_NOT_APPROVED',
    });
    await expect(
      new FacetVocabularyRepository().approve(ACCOUNT, [
        { facet: 'domain', name: 'finance', definition: 'Money things, at some length.' },
      ]),
    ).rejects.toMatchObject({ code: 'FACET_VOCABULARY_EMPTY', statusCode: 422 });
  });

  /**
   * A proposal is written where the classifier cannot see it, and leaves the approved set alone —
   * the mailbox keeps being classified against what it agreed to until somebody agrees to
   * something else.
   */
  it('records a proposal without disturbing what is approved', async () => {
    mocks.findMany.mockResolvedValue([]);

    await new FacetVocabularyRepository().propose(ACCOUNT, [
      { facet: 'domain', name: 'finance', definition: 'Money things, at some length.' },
    ]);

    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: { connected_google_account_id: ACCOUNT, status: 'PROPOSED' },
    });
    const created = mocks.createMany.mock.calls[0]![0].data;
    expect(created[0]).toMatchObject({ status: 'PROPOSED', position: 0 });
  });

  /**
   * Approving replaces rather than merges. A vocabulary is a closed set the model chooses from, so
   * a value left out of the approval has to stop being returnable — merging would make removal
   * impossible.
   */
  it('replaces the whole set on approval so a value can actually be removed', async () => {
    mocks.findMany.mockResolvedValue([]);

    await new FacetVocabularyRepository().approve(ACCOUNT, [
      { facet: 'domain', name: 'finance', definition: 'Money things, at some length.' },
      { facet: 'intent', name: 'payment-failed', definition: 'A payment did not go through.' },
    ]);

    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: { connected_google_account_id: ACCOUNT },
    });
    expect(mocks.createMany.mock.calls[0]![0].data).toHaveLength(2);
  });
});

/**
 * `prompt_version` is already what makes a decision stale. Folding the vocabulary into it means an
 * account that rewords a definition re-classifies the mail decided under the old wording, through
 * machinery that already exists rather than a new one.
 */
describe('the fingerprint that makes a decision stale', () => {
  const base = {
    domain: [{ name: 'finance', definition: 'Money things.' }],
    intent: [{ name: 'payment-failed', definition: 'It did not go through.' }],
  };

  it('changes when a value is added', () => {
    const wider = { ...base, domain: [...base.domain, { name: 'career', definition: 'Work.' }] };
    expect(vocabularyFingerprint(wider)).not.toBe(vocabularyFingerprint(base));
  });

  // The definition is what the model is actually shown, so rewording it is a different question.
  it('changes when only a definition is reworded', () => {
    const reworded = {
      ...base,
      intent: [{ name: 'payment-failed', definition: 'A charge was declined.' }],
    };
    expect(vocabularyFingerprint(reworded)).not.toBe(vocabularyFingerprint(base));
  });

  it('is stable for the same vocabulary, so unchanged mail is not re-classified', () => {
    expect(facetPromptVersion(base)).toBe(facetPromptVersion({ ...base }));
    expect(facetPromptVersion(base)).toContain('mailmind-facet-classifier-v2');
  });
});
