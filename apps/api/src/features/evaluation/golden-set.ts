import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { AppError } from '@api/errors/AppError.js';

/**
 * The labelled set the classifier is measured against.
 *
 * Checked in as a fixture rather than drawn live, for the reason every evaluation set is: a metric
 * that moves because the sample moved measures nothing. The same messages, the same labels, every
 * run — so a prompt change has to explain itself against a fixed target.
 *
 * The labels are a **person's**, and no code here can produce them. `npm run eval:facets -- --draw`
 * writes a stratified, unlabelled draw from a real mailbox; a human fills in `expectedDomain` and
 * `expectedIntent`; that file becomes the fixture. Anything else — labelling with a second model,
 * or accepting the classifier's own answers — measures agreement rather than correctness, which is
 * exactly the mistake this card exists to stop.
 */

const facetValue = z
  .string()
  .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
  .max(64);

const entrySchema = z
  .object({
    /** Gmail's own id, so a disagreement can be opened and looked at. */
    gmailMessageId: z.string().min(1).max(64),
    subject: z.string().max(500),
    senderEmail: z.string().max(320),
    /** The stored preview, bounded exactly as the classifier bounds it. */
    snippet: z.string().max(200).default(''),
    /**
     * What a person says this message is. `null` means no value of the vocabulary fits, which is
     * a real answer and is scored as one — it is what `UNKNOWN` means to the classifier too.
     */
    expectedDomain: facetValue.nullable(),
    expectedIntent: facetValue.nullable(),
    /** Why this message is in the set. Optional, and worth writing for the awkward ones. */
    note: z.string().max(300).optional(),
  })
  .strict();

const goldenSetSchema = z
  .object({
    /**
     * The vocabulary these labels were assigned under. A label is only meaningful relative to the
     * set of values it was chosen from, so a run against a different vocabulary is refused rather
     * than silently scored against labels that no longer mean the same thing.
     */
    vocabularyFingerprint: z.string().min(1).max(64).optional(),
    labelledBy: z.string().max(120).optional(),
    labelledAt: z.string().max(40).optional(),
    entries: z.array(entrySchema),
  })
  .strict();

export type GoldenSetEntry = z.infer<typeof entrySchema>;
export type GoldenSet = z.infer<typeof goldenSetSchema>;

export async function loadGoldenSet(path: string): Promise<GoldenSet> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new AppError(
      'CLASSIFICATION_VALIDATION_FAILED',
      `No readable golden set at ${path}.`,
      422,
    );
  }
  return parseGoldenSet(raw);
}

/**
 * Validates a golden set and refuses the ways one silently stops measuring anything.
 *
 * An empty set, or one where every message carries the same label, produces a confident-looking
 * report about nothing at all. Both are far likelier than a malformed file, and neither would
 * throw on its own.
 */
export function parseGoldenSet(raw: unknown): GoldenSet {
  const parsed = goldenSetSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(
      'CLASSIFICATION_VALIDATION_FAILED',
      'The golden set does not match the expected shape.',
      422,
    );
  }
  const { entries } = parsed.data;
  if (entries.length === 0) {
    throw new AppError('CLASSIFICATION_VALIDATION_FAILED', 'The golden set is empty.', 422);
  }
  const ids = new Set(entries.map((entry) => entry.gmailMessageId));
  if (ids.size !== entries.length) {
    throw new AppError(
      'CLASSIFICATION_VALIDATION_FAILED',
      'The golden set labels the same message twice.',
      422,
    );
  }
  return parsed.data;
}

/** How much of each label the set actually holds — the thing a stratified draw is aiming at. */
export function goldenSetCoverage(set: GoldenSet): {
  entries: number;
  domainValues: number;
  intentValues: number;
  unlabelled: number;
} {
  const domains = new Set(set.entries.map((entry) => entry.expectedDomain ?? 'UNKNOWN'));
  const intents = new Set(set.entries.map((entry) => entry.expectedIntent ?? 'UNKNOWN'));
  return {
    entries: set.entries.length,
    domainValues: domains.size,
    intentValues: intents.size,
    // A drawn-but-unfilled row: both axes still null AND no note. Counted so a half-laboured set
    // cannot quietly report itself as ninety per cent accurate on the rows nobody filled in.
    unlabelled: set.entries.filter(
      (entry) => entry.expectedDomain === null && entry.expectedIntent === null && !entry.note,
    ).length,
  };
}
