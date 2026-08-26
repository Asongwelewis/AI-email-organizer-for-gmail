import { createHash } from 'node:crypto';

import { prisma } from '@api/database/prisma.js';
import { AppError } from '@api/errors/AppError.js';
import { MODEL_FACET_NAMES, type FacetVocabularyValue, type ModelFacetName } from './facets.js';

/**
 * The vocabulary one mailbox owner approved.
 *
 * `facets.ts` still holds a set of domains and intents as a checked-in constant, and it is still
 * correct — for the mailbox it was designed from, on the day it was designed. It is not a default
 * for anybody else: "career, development, education" is a description of one person's life, and a
 * second user classified against it would be filed into a stranger's taxonomy no matter how good
 * the authentication around it was.
 *
 * So the vocabulary is per account, and it arrives the way folders do: a grounded proposal that
 * writes nothing the classifier can speak, then a human approval. Until that approval exists the
 * classifier refuses to run, exactly as automation refused to run before a label was confirmed.
 */

export type AccountVocabulary = Record<ModelFacetName, FacetVocabularyValue[]>;

export interface VocabularyDraft {
  facet: ModelFacetName;
  name: string;
  definition: string;
}

function isModelFacet(value: string): value is ModelFacetName {
  return (MODEL_FACET_NAMES as readonly string[]).includes(value);
}

const emptyVocabulary = (): AccountVocabulary => ({ domain: [], intent: [] });

/**
 * A fingerprint of the values and their definitions.
 *
 * It goes into the stored `prompt_version`, which is already what makes a decision stale: the
 * classifier re-runs any message whose version no longer matches. So changing a definition — not
 * only adding a value — re-classifies the mail that was decided under the old wording, with no new
 * mechanism and no migration.
 */
export function vocabularyFingerprint(vocabulary: AccountVocabulary): string {
  const canonical = MODEL_FACET_NAMES.map((facet) =>
    vocabulary[facet].map((value) => `${value.name}=${value.definition}`).join(''),
  ).join('');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

export class FacetVocabularyRepository {
  /** The approved vocabulary, or empty when this account has never approved one. */
  async approved(accountId: string): Promise<AccountVocabulary> {
    return this.read(accountId, 'APPROVED');
  }

  /** The pending proposal, or empty when nothing is pending. */
  async proposed(accountId: string): Promise<AccountVocabulary> {
    return this.read(accountId, 'PROPOSED');
  }

  /**
   * The approved vocabulary, or a refusal.
   *
   * Every path that asks a model to classify goes through this rather than through `approved`, so
   * "we have never agreed what this mailbox's domains are" can never be silently answered with
   * somebody else's list.
   */
  async requireApproved(accountId: string): Promise<AccountVocabulary> {
    const vocabulary = await this.approved(accountId);
    if (vocabulary.domain.length === 0 || vocabulary.intent.length === 0) {
      throw new AppError(
        'FACET_VOCABULARY_NOT_APPROVED',
        'Propose and approve a facet vocabulary for this mailbox before classifying it.',
        409,
      );
    }
    return vocabulary;
  }

  private async read(
    accountId: string,
    status: 'PROPOSED' | 'APPROVED',
  ): Promise<AccountVocabulary> {
    const rows = await prisma.facet_vocabularies.findMany({
      where: { connected_google_account_id: accountId, status },
      orderBy: [{ facet: 'asc' }, { position: 'asc' }, { name: 'asc' }],
      select: { facet: true, name: true, definition: true },
    });
    const vocabulary = emptyVocabulary();
    for (const row of rows) {
      if (isModelFacet(row.facet)) {
        vocabulary[row.facet].push({ name: row.name, definition: row.definition });
      }
    }
    return vocabulary;
  }

  /**
   * Records a proposal. Replaces any earlier one and touches the approved set not at all — the
   * classifier keeps speaking what was approved until somebody approves something else.
   */
  async propose(accountId: string, values: VocabularyDraft[]): Promise<AccountVocabulary> {
    await prisma.$transaction([
      prisma.facet_vocabularies.deleteMany({
        where: { connected_google_account_id: accountId, status: 'PROPOSED' },
      }),
      prisma.facet_vocabularies.createMany({
        data: values.map((value, position) => ({
          connected_google_account_id: accountId,
          facet: value.facet,
          name: value.name,
          definition: value.definition,
          status: 'PROPOSED' as const,
          position,
        })),
        skipDuplicates: true,
      }),
    ]);
    return this.proposed(accountId);
  }

  /**
   * Approves a set of values, replacing whatever was approved before.
   *
   * A replacement rather than a merge, because a vocabulary is a closed set the model chooses from:
   * a value left out of the approval is a value the classifier must stop being able to return, and
   * merging would make removal impossible. Mail already classified into a dropped value keeps its
   * row — the `prompt_version` fingerprint changes, so it re-classifies on the next pass rather
   * than being deleted out from under the folders it is in.
   */
  async approve(accountId: string, values: VocabularyDraft[]): Promise<AccountVocabulary> {
    if (values.length === 0) {
      throw new AppError('FACET_VOCABULARY_EMPTY', 'A vocabulary needs at least one value.', 422);
    }
    for (const facet of MODEL_FACET_NAMES) {
      if (!values.some((value) => value.facet === facet)) {
        throw new AppError(
          'FACET_VOCABULARY_EMPTY',
          `A vocabulary needs at least one ${facet} value.`,
          422,
        );
      }
    }
    await prisma.$transaction([
      prisma.facet_vocabularies.deleteMany({
        where: { connected_google_account_id: accountId },
      }),
      prisma.facet_vocabularies.createMany({
        data: values.map((value, position) => ({
          connected_google_account_id: accountId,
          facet: value.facet,
          name: value.name,
          definition: value.definition,
          status: 'APPROVED' as const,
          position,
        })),
        skipDuplicates: true,
      }),
    ]);
    return this.approved(accountId);
  }
}

export const facetVocabularyRepository = new FacetVocabularyRepository();
