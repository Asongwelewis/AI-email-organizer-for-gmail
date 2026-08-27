/**
 * Measures the facet classifier against a labelled set, instead of guessing at it.
 *
 * `report:facets` prints distributions, and a distribution is not correctness — a classifier that
 * answers "newsletter" to everything produces a perfectly plausible one. This prints precision and
 * recall per value, a confusion matrix, the reliability curve, and what each candidate confidence
 * threshold would actually do.
 *
 * Two modes, because the labels are a person's and no script can produce them:
 *
 *   npm run eval:facets --workspace @mailmind/api -- --draw 300 > golden-set.json
 *     A stratified, UNLABELLED draw from the mailbox. Fill in expectedDomain and expectedIntent
 *     by hand, save it as test/fixtures/golden-set.json, and it becomes the fixture.
 *
 *   npm run eval:facets --workspace @mailmind/api
 *     Runs the classifier over the fixture and reports. One Gemini call per batch; writes nothing.
 *
 * Labelling with a second model, or accepting the classifier's own answers, would measure
 * agreement rather than correctness — which is the mistake this exists to stop.
 */
import { fileURLToPath } from 'node:url';

import { prisma } from '../src/database/prisma.js';
import { emailIdentity } from '../src/features/label-discovery/label-normalization.js';
import {
  facetPromptVersion,
  geminiFacetClassifier,
  UNKNOWN_FACET,
  type FacetClassifierInput,
} from '../src/features/automation/facet-classifier.js';
import { facetVocabularyRepository } from '../src/features/label-discovery/facet-vocabulary.repository.js';
import { APPROVED_FACET_VOCABULARY } from '../src/features/label-discovery/facets.js';
import {
  goldenSetCoverage,
  loadGoldenSet,
  type GoldenSetEntry,
} from '../src/features/evaluation/golden-set.js';
import {
  facetReport,
  NO_VALUE,
  type FacetReport,
  type LabelledDecision,
} from '../src/features/evaluation/metrics.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name: string) => args.includes(name);

const email = flag('--email');
const fixturePath =
  flag('--set') ?? fileURLToPath(new URL('../test/fixtures/golden-set.json', import.meta.url));
const batchSize = Number(flag('--batch') ?? 20);

const write = (line = '') => process.stdout.write(`${line}\n`);
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

async function activeAccount() {
  const account = await prisma.connected_google_accounts.findFirst({
    where: { gmail_connected: true, ...(email ? { email } : {}) },
    orderBy: { updated_at: 'desc' },
  });
  if (!account) throw new Error('No connected Gmail account found.');
  return account;
}

/**
 * A stratified, unlabelled draw.
 *
 * Round-robin across the classifier's own current answers rather than uniform, because a uniform
 * draw spends three hundred rows on the two values that dominate the mailbox and leaves the rare
 * ones — the ones a person is actually searching for — with two examples each. Messages with no
 * facets at all are included deliberately: unclassified mail is exactly what a vocabulary is
 * failing to describe.
 */
async function draw(limit: number): Promise<void> {
  const account = await activeAccount();
  const rows = await prisma.gmail_message_metadata.findMany({
    where: {
      connected_google_account_id: account.id,
      deleted_at: null,
      is_trashed: false,
      is_draft: false,
      sender_email: { not: null },
    },
    orderBy: { internal_date: 'desc' },
    take: 20_000,
    select: {
      gmail_message_id: true,
      subject: true,
      sender_email: true,
      snippet: true,
      facets: { select: { domain: true, intent: true } },
    },
  });

  const buckets = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.facets?.domain ?? NO_VALUE}|${row.facets?.intent ?? NO_VALUE}`;
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }
  const keys = [...buckets.keys()].sort();
  const picked: typeof rows = [];
  for (let round = 0; picked.length < limit; round += 1) {
    let tookAny = false;
    for (const key of keys) {
      const bucket = buckets.get(key)!;
      if (round >= bucket.length) continue;
      picked.push(bucket[round]!);
      tookAny = true;
      if (picked.length >= limit) break;
    }
    if (!tookAny) break;
  }

  write(
    JSON.stringify(
      {
        labelledBy: 'REPLACE ME',
        labelledAt: new Date().toISOString().slice(0, 10),
        entries: picked.map((row) => ({
          gmailMessageId: row.gmail_message_id,
          subject: row.subject ?? '',
          senderEmail: row.sender_email ?? '',
          snippet: (row.snippet ?? '').slice(0, 200),
          // Deliberately null. These are the two fields a person fills in, and pre-filling them
          // with the classifier's own answers would turn the exercise into confirming itself.
          expectedDomain: null,
          expectedIntent: null,
        })),
      },
      null,
      2,
    ),
  );
  process.stderr.write(
    `Drew ${picked.length} messages across ${keys.length} facet combinations.\n` +
      'Fill in expectedDomain and expectedIntent by hand before using this as a fixture.\n',
  );
}

function printReport(report: FacetReport): void {
  write();
  write(
    `${report.facet.toUpperCase()} — ${report.correct}/${report.total} correct (${pct(report.accuracy)}), macro F1 ${report.macroF1.toFixed(3)}`,
  );
  write('─'.repeat(90));
  write('  value                     support  predicted  precision   recall       F1');
  for (const value of report.perValue) {
    write(
      `  ${value.value.padEnd(24)} ${String(value.support).padStart(7)} ` +
        `${String(value.predicted).padStart(10)} ${pct(value.precision).padStart(10)} ` +
        `${pct(value.recall).padStart(8)} ${value.f1.toFixed(3).padStart(8)}`,
    );
  }

  write();
  write('  Where it went wrong (expected → actual, commonest first)');
  const wrong = report.confusion.filter((cell) => cell.expected !== cell.actual);
  if (wrong.length === 0) write('    nothing — every decision matched its label');
  for (const cell of wrong.slice(0, 15)) {
    write(`    ${cell.expected.padEnd(24)} → ${cell.actual.padEnd(24)} ${cell.count}`);
  }

  write();
  write(
    `  Reliability — is the confidence honest? (calibration error ${pct(report.calibrationError)})`,
  );
  write('    bin          n   claimed   observed      gap');
  for (const bin of report.reliability) {
    if (bin.count === 0) continue;
    const sign = bin.gap < 0 ? 'overconfident' : '';
    write(
      `    ${bin.lowerBound.toFixed(1)}–${bin.upperBound.toFixed(1)} ${String(bin.count).padStart(6)} ` +
        `${pct(bin.meanConfidence).padStart(9)} ${pct(bin.accuracy).padStart(10)} ` +
        `${(bin.gap >= 0 ? '+' : '') + pct(bin.gap).padStart(7)}  ${sign}`,
    );
  }

  write();
  write('  What a threshold would cost — this is what chooses the review queue');
  write('    threshold   auto-filed   of those right   held back   correct held back');
  for (const outcome of report.thresholdSweep) {
    write(
      `    ${outcome.threshold.toFixed(2).padStart(9)} ${String(outcome.autoFiled).padStart(12)} ` +
        `${pct(outcome.precisionOfAutoFiled).padStart(16)} ${String(outcome.heldForReview).padStart(11)} ` +
        `${String(outcome.correctHeldBack).padStart(19)}`,
    );
  }
}

async function evaluate(): Promise<void> {
  const account = await activeAccount();
  const vocabulary = await facetVocabularyRepository
    .approved(account.id)
    .then((approved) =>
      approved.domain.length > 0 && approved.intent.length > 0
        ? approved
        : APPROVED_FACET_VOCABULARY,
    );
  const promptVersion = facetPromptVersion(vocabulary);
  const set = await loadGoldenSet(fixturePath);
  const coverage = goldenSetCoverage(set);

  write(`Golden set: ${fixturePath}`);
  write(
    `  ${coverage.entries} messages, ${coverage.domainValues} domain values, ` +
      `${coverage.intentValues} intent values, ${coverage.unlabelled} still unlabelled`,
  );
  write(`  prompt version: ${promptVersion}`);
  /*
   * The gate the card asks for. A label is only meaningful relative to the vocabulary it was
   * chosen from, so a run against a different one is refused rather than silently scored against
   * labels that no longer mean the same thing.
   */
  if (set.vocabularyFingerprint && !promptVersion.endsWith(set.vocabularyFingerprint)) {
    write();
    write(
      `REFUSED: these labels were assigned under vocabulary ${set.vocabularyFingerprint}, and this ` +
        'mailbox now uses a different one. Re-label, or evaluate against the vocabulary they were ' +
        'assigned under.',
    );
    process.exitCode = 1;
    return;
  }
  if (coverage.unlabelled > 0) {
    write();
    write(
      `WARNING: ${coverage.unlabelled} row(s) have neither facet filled in and no note. They are ` +
        'scored as "no value fits", which is probably not what was meant.',
    );
  }

  const decisions: { domain: LabelledDecision[]; intent: LabelledDecision[] } = {
    domain: [],
    intent: [],
  };
  const entries = set.entries;
  for (let start = 0; start < entries.length; start += batchSize) {
    const batch = entries.slice(start, start + batchSize);
    const inputs: FacetClassifierInput[] = batch.map((entry, index) => ({
      key: `m${index + 1}`,
      subject: entry.subject,
      sender: entry.senderEmail,
      senderHost: emailIdentity(entry.senderEmail).senderDomain,
      snippet: entry.snippet,
    }));
    const result = await geminiFacetClassifier.classify(inputs, { vocabulary });
    const byKey = new Map(result.classifications.map((item) => [item.key, item]));
    batch.forEach((entry: GoldenSetEntry, index) => {
      const answer = byKey.get(`m${index + 1}`);
      decisions.domain.push({
        id: entry.gmailMessageId,
        expected: entry.expectedDomain,
        actual: answer?.domain ?? null,
        confidence: answer?.domainConfidence ?? 0,
      });
      decisions.intent.push({
        id: entry.gmailMessageId,
        expected: entry.expectedIntent,
        actual: answer?.intent ?? null,
        confidence: answer?.intentConfidence ?? 0,
      });
    });
    process.stderr.write(
      `classified ${Math.min(start + batchSize, entries.length)}/${entries.length}\n`,
    );
  }

  printReport(facetReport('domain', decisions.domain));
  printReport(facetReport('intent', decisions.intent));
  write();
  write(`(${UNKNOWN_FACET} and ${NO_VALUE} both mean "no value of the vocabulary fits".)`);
}

async function main(): Promise<void> {
  const drawCount = flag('--draw');
  if (drawCount !== undefined || has('--draw')) {
    await draw(Number(drawCount ?? 300));
    return;
  }
  await evaluate();
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
