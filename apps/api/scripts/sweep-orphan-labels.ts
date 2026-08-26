/**
 * Sweeps MailMind labels that no folder claims any more.
 *
 * Three generations of labels ended up in the same mailbox: the tree planner's
 * (`MailMind/Finance/Transactions/Failed payments`), the facet pivot's (`MailMind/OpenAI/Payment
 * failed`), and stage-3 leftovers (`MailMind/Processed`, `MailMind/Needs Review`). Retiring the
 * legacy engine stops new ones appearing; it does not remove the ones already there.
 *
 * It has to be a deliberate sweep because **deleting a Gmail label never unlabels the mail beneath
 * it**. Deleting the label alone would drop the folder out of Gmail's sidebar while every message
 * it held keeps an invisible label id, and nothing afterwards could find them again. So the order
 * matters, and it is the same order `unapply-pivot.ts` uses:
 *
 *   1. strip the orphaned label from every message that still carries it, in batches;
 *   2. only then delete the Gmail label itself.
 *
 * Two things count as orphaned, and the first version of this script only caught one of them:
 *
 *   1. a Gmail label under `MailMind/` that no `user_labels` row names — the stage-3 leftovers;
 *   2. a folder row that matches no combination in the CURRENT pivot — the planner-era tree.
 *
 * The second is the one card 12 actually named (`Finance/Transactions/Failed payments`), and it
 * was being missed precisely because those folders still have rows: `apply` reports them and
 * deliberately leaves them alone, because removing a folder is a decision for a person rather
 * than a side effect of re-running a pivot. This script is where that person decides.
 *
 * Dry run by default. Nothing is touched without `--apply`.
 *
 *   npm run sweep:labels --workspace @mailmind/api
 *   npm run sweep:labels --workspace @mailmind/api -- --apply
 */
import { prisma } from '../src/database/prisma.js';
import { pivotService } from '../src/features/labels/pivot.service.js';
import { createGmailClient, withGmailRetry } from '../src/integrations/gmail/gmail.client.js';

const apply = process.argv.slice(2).includes('--apply');
const write = (line = '') => process.stdout.write(`${line}\n`);

/** Gmail caps `messages.modify` batches at 1000 ids. */
const BATCH = 1000;

async function main(): Promise<void> {
  const account = await prisma.connected_google_accounts.findFirst({
    where: { gmail_connected: true, connection_status: 'CONNECTED' },
    orderBy: { updated_at: 'desc' },
  });
  if (!account) {
    process.stderr.write('No connected Gmail account.\n');
    process.exitCode = 1;
    return;
  }

  const [labels, plan] = await Promise.all([
    prisma.gmail_labels.findMany({
      where: { connected_google_account_id: account.id, name: { startsWith: 'MailMind/' } },
      select: { gmail_label_id: true, name: true },
    }),
    pivotService.plan(account.id),
  ]);

  // Folders the current pivot still produces. Everything else under MailMind/ is dead.
  const live = new Set(plan.changes.map((change) => change.fullPath));
  const orphanRowIds = new Map(plan.orphaned.map((row) => [row.fullPath, row.id]));
  const orphans = labels.filter((label) => label.name && !live.has(label.name));

  if (orphans.length === 0) {
    write('No orphaned MailMind labels. Every label in Gmail is a folder the pivot still makes.');
    return;
  }

  write(`${orphans.length} orphaned MailMind label(s), against ${live.size} live folder(s):`);
  const gmail = await createGmailClient(account.id);

  for (const orphan of orphans) {
    // Counted from stored metadata rather than a Gmail search: sync already knows which messages
    // carry the label, and this avoids a query per orphan against the API.
    const holders = await prisma.gmail_message_metadata.findMany({
      where: {
        connected_google_account_id: account.id,
        label_ids: { has: orphan.gmail_label_id },
      },
      select: { id: true, gmail_message_id: true, label_ids: true },
    });
    write(`  ${orphan.name} — ${holders.length} message(s) still carry it`);
    if (!apply) continue;

    for (let index = 0; index < holders.length; index += BATCH) {
      const batch = holders.slice(index, index + BATCH);
      await withGmailRetry(() =>
        gmail.users.messages.batchModify({
          userId: 'me',
          requestBody: {
            ids: batch.map((message) => message.gmail_message_id),
            removeLabelIds: [orphan.gmail_label_id],
          },
        }),
      );
      // Keep the stored metadata in step, or the next filing run would still believe these
      // messages wear a MailMind label and try to strip one that no longer exists. Only the
      // orphan comes off: a message's own labels, and INBOX, are not MailMind's to touch.
      await Promise.all(
        batch.map((message) =>
          prisma.gmail_message_metadata.update({
            where: { id: message.id },
            data: {
              label_ids: {
                set: message.label_ids.filter((id) => id !== orphan.gmail_label_id),
              },
            },
          }),
        ),
      );
    }

    // Only now, with no message left wearing it.
    await withGmailRetry(() =>
      gmail.users.labels.delete({ userId: 'me', id: orphan.gmail_label_id }),
    );
    await prisma.gmail_labels.deleteMany({
      where: { connected_google_account_id: account.id, gmail_label_id: orphan.gmail_label_id },
    });
    // A planner-era folder also has a row to remove, or the next pivot would adopt it straight
    // back. The tree cascades, so removing a branch removes what hung beneath it.
    const rowId = orphan.name ? orphanRowIds.get(orphan.name) : undefined;
    if (rowId) {
      await prisma.user_labels.deleteMany({
        where: { connected_google_account_id: account.id, id: rowId },
      });
    }
    write(`    swept`);
  }

  write();
  write(
    apply
      ? 'Swept. Mail that carried an orphaned label is back in the inbox, unlabelled by MailMind.'
      : 'Dry run. Re-run with --apply to strip these labels from their mail and delete them.',
  );
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
