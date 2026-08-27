/**
 * Undoes what the pivot did, against a snapshot taken before it ran.
 *
 * Written alongside the pivot rather than after it, so the rollback is testable before it is
 * needed. Dry run by default; `--apply` performs the reversal.
 *
 * It does three things, in the order that keeps the mailbox consistent at every step:
 *   1. removes MailMind labels from any message an automation run applied them to, so mail is
 *      never left wearing a label whose folder is about to disappear;
 *   2. deletes the Gmail labels that are absent from the snapshot — the ones the pivot created;
 *   3. deletes the `user_labels` rows the pivot created, identified by `facet_key`.
 *
 * Deleting a Gmail label does not delete or unlabel mail, which is why step 1 comes first and is
 * driven by `automation_message_actions` — every application recorded its message and its label.
 *
 *   npm run unapply:pivot --workspace @mailmind/api -- --snapshot backups/pre-pivot-...
 *   npm run unapply:pivot --workspace @mailmind/api -- --snapshot backups/pre-pivot-... --apply
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { prisma } from '../src/database/prisma.js';
import { createGmailClient, withGmailRetry } from '../src/integrations/gmail/gmail.client.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const snapshotIndex = args.indexOf('--snapshot');
const snapshot = snapshotIndex >= 0 ? args[snapshotIndex + 1] : undefined;

const write = (line = '') => process.stdout.write(`${line}\n`);

async function main(): Promise<void> {
  if (!snapshot) {
    process.stderr.write('Pass --snapshot <directory> from npm run backup:pivot.\n');
    process.exitCode = 1;
    return;
  }
  const before = JSON.parse(
    await readFile(join(snapshot, 'gmail_labels_live.json'), 'utf8'),
  ) as Array<{ id: string | null; name: string | null }>;
  const beforeIds = new Set(before.map((label) => label.id).filter(Boolean));

  const account = await prisma.connected_google_accounts.findFirst({
    where: { gmail_connected: true, connection_status: 'CONNECTED' },
    orderBy: { updated_at: 'desc' },
  });
  if (!account) {
    process.stderr.write('No connected Gmail account found.\n');
    process.exitCode = 1;
    return;
  }
  const gmail = await createGmailClient(account.id);
  const live = await withGmailRetry(() => gmail.users.labels.list({ userId: 'me' }));
  const created = (live.data.labels ?? []).filter(
    (label) => label.id && label.name?.startsWith('MailMind/') && !beforeIds.has(label.id),
  );

  // Every label application is durably recorded, so un-applying is a replay of that record rather
  // than a search of the mailbox.
  const applied = await prisma.automation_message_actions.findMany({
    where: {
      connected_google_account_id: account.id,
      applied_at: { not: null },
      gmail_label_id: { in: created.map((label) => label.id!) },
    },
    select: { id: true, gmail_label_id: true, message: { select: { gmail_message_id: true } } },
  });

  const pivotRows = await prisma.user_labels.findMany({
    where: { connected_google_account_id: account.id, facet_key: { not: null } },
    select: { id: true, full_path: true },
  });

  write(`Snapshot ${snapshot}`);
  write(`  ${created.length} Gmail label(s) created since the snapshot`);
  write(`  ${applied.length} message label application(s) to reverse`);
  write(`  ${pivotRows.length} user_labels row(s) carrying a facet key`);
  write();

  if (!apply) {
    write('Dry run. Nothing was changed. Re-run with --apply to reverse.');
    return;
  }

  let unlabelled = 0;
  for (const action of applied) {
    await withGmailRetry(() =>
      gmail.users.messages.modify({
        userId: 'me',
        id: action.message.gmail_message_id,
        requestBody: { removeLabelIds: [action.gmail_label_id!] },
      }),
    );
    unlabelled += 1;
  }

  let deleted = 0;
  for (const label of created) {
    await withGmailRetry(() => gmail.users.labels.delete({ userId: 'me', id: label.id! }));
    deleted += 1;
  }

  await prisma.gmail_labels.deleteMany({
    where: {
      connected_google_account_id: account.id,
      gmail_label_id: { in: created.map((label) => label.id!) },
    },
  });
  const removed = await prisma.user_labels.deleteMany({
    where: { connected_google_account_id: account.id, facet_key: { not: null } },
  });

  write(
    `Reversed: ${unlabelled} message(s) unlabelled, ${deleted} Gmail label(s) deleted, ` +
      `${removed.count} folder row(s) removed.`,
  );
  write('No mail was deleted. Folders that predate the pivot were left untouched.');
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
