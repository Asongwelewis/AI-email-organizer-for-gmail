/**
 * Recomputes the `entity` facet for mail that is already classified.
 *
 * `entity` is derived from the sender in code, not asked of a model, so a change to that derivation
 * costs nothing to apply — no Gemini call, no token budget, no waiting for the nightly run. But
 * nothing re-derives it on its own either: `prompt_version` tracks the prompt and the vocabulary,
 * and `input_hash` tracks the message, so a rule change in our own code is invisible to both.
 *
 * That gap is what this closes. It was written for the Substack fix — every publication on a
 * hosting platform had collapsed into one folder — and it applies to any later change in how a
 * brand is read off an address.
 *
 *   npm run rederive:entities --workspace @mailmind/api              # dry run, writes nothing
 *   npm run rederive:entities --workspace @mailmind/api -- --apply
 */
import { prisma } from '../src/database/prisma.js';
import { entityFor } from '../src/features/label-discovery/entity.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const emailIndex = args.indexOf('--email');
const email = emailIndex >= 0 ? args[emailIndex + 1] : undefined;

const write = (line = '') => process.stdout.write(`${line}\n`);

async function main(): Promise<void> {
  const account = await prisma.connected_google_accounts.findFirst({
    where: { gmail_connected: true, ...(email ? { email } : {}) },
    orderBy: { updated_at: 'desc' },
  });
  if (!account) throw new Error('No connected Gmail account found.');

  const rows = await prisma.message_facets.findMany({
    where: { connected_google_account_id: account.id },
    select: { id: true, entity: true, message: { select: { sender_email: true } } },
  });

  /** Every row whose stored brand disagrees with what the current rules would derive. */
  const changes = rows
    .map((row) => ({ id: row.id, from: row.entity, to: entityFor(row.message.sender_email) }))
    .filter((change) => change.from !== change.to);

  write(`Account: ${account.email}`);
  write(`${rows.length} classified message(s), ${changes.length} whose brand has changed.`);

  if (changes.length === 0) {
    write('\nNothing to do.');
    return;
  }

  // Grouped, because "3,412 rows changed" says nothing and "substack -> bytebytego, 66" says what
  // the change actually was and whether it is the one that was intended.
  const grouped = new Map<string, number>();
  for (const change of changes) {
    const key = `${change.from ?? 'none'} -> ${change.to ?? 'none'}`;
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }
  write();
  for (const [move, count] of [...grouped.entries()].sort((left, right) => right[1] - left[1])) {
    write(`  ${String(count).padStart(6)}  ${move}`);
  }

  if (!apply) {
    write('\nDry run. Nothing was written. Re-run with --apply.');
    return;
  }

  /*
   * One statement per row, sequentially. The pooled connection allows very little concurrency — a
   * fan-out here is what exhausted the pool during the label sweep — and this is a few thousand
   * rows once, not a hot path.
   */
  let updated = 0;
  for (const change of changes) {
    await prisma.message_facets.update({
      where: { id: change.id },
      data: { entity: change.to },
    });
    updated += 1;
    if (updated % 500 === 0) write(`  updated ${updated}/${changes.length}`);
  }
  write(`\nUpdated ${updated} message(s). The folders rebuild from these rows on the next read.`);
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
