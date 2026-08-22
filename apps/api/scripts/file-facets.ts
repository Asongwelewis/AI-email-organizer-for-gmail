/**
 * Files the mailbox into the folders the canonical pivot produced.
 *
 * This is the only script that puts a label ON MAIL. It spends no tokens — the classification is
 * already stored — and every message ends with exactly one MailMind label or none, because the
 * apply removes any label left over from the previous tree in the same call that adds the new one.
 *
 * Dry run by default.
 *
 *   npm run file:facets --workspace @mailmind/api
 *   npm run file:facets --workspace @mailmind/api -- --apply
 */
import { prisma } from '../src/database/prisma.js';
import { facetFilingService } from '../src/features/automation/facet-filing.service.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const limitArg = Number(args.includes('--limit') ? args[args.indexOf('--limit') + 1] : NaN);
const limit = Number.isFinite(limitArg) && limitArg > 0 ? Math.floor(limitArg) : undefined;

const write = (line = '') => process.stdout.write(`${line}\n`);

async function main(): Promise<void> {
  const account = await prisma.connected_google_accounts.findFirst({
    where: { gmail_connected: true, connection_status: 'CONNECTED' },
    orderBy: { updated_at: 'desc' },
  });
  if (!account) {
    process.stderr.write('No connected Gmail account found.\n');
    process.exitCode = 1;
    return;
  }
  const result = await facetFilingService.fileAccount(account.id, account.user_id, {
    dryRun: !apply,
    ...(limit ? { limit } : {}),
  });
  write(`Account ${account.email} — pivot [${result.pivot.order.join(' > ')}]`);
  write(
    `Seen ${result.seen}: ${result.filed} filed, ${result.none} left in the inbox, ` +
      `${result.reviewRequired} held for review, ${result.failed} failed.`,
  );
  write(
    `Facets behind those decisions: ${result.fromRules} from rules, ${result.fromModel} from the model.`,
  );
  if (apply) {
    write(
      `Gmail: ${result.labelsCreated} label(s) created, ${result.labelsReused} reused, ` +
        `${result.staleLabelsRemoved} stale label(s) removed from mail.`,
    );
  } else {
    write('Dry run. Decisions were recorded; Gmail was not called. Re-run with --apply.');
  }
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
