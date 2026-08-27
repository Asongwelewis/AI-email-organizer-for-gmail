/**
 * Snapshots everything the pivot is about to write, so rolling it back is a restore rather than a
 * reconstruction.
 *
 * Read-only. Four database tables plus the LIVE Gmail label set — live, because `gmail_labels` is
 * a projection that a stale sync can misreport, and "which labels existed before" has to be a fact
 * rather than a memory when it is used to decide what to delete.
 *
 *   npm run backup:pivot --workspace @mailmind/api
 *   npm run backup:pivot --workspace @mailmind/api -- --email you@example.com
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prisma } from '../src/database/prisma.js';
import { gmailSyncService } from '../src/integrations/gmail/gmail.service.js';

const args = process.argv.slice(2);
const emailIndex = args.indexOf('--email');
const email = emailIndex >= 0 ? args[emailIndex + 1] : undefined;

const write = (line = '') => process.stdout.write(`${line}\n`);

/** BigInt and Date are both routine here and neither survives JSON.stringify unaided. */
const serialize = (value: unknown) =>
  JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === 'bigint' ? Number(item) : item),
    2,
  );

async function main(): Promise<void> {
  const account = await prisma.connected_google_accounts.findFirst({
    where: {
      gmail_connected: true,
      connection_status: 'CONNECTED',
      ...(email ? { email } : {}),
    },
    orderBy: { updated_at: 'desc' },
  });
  if (!account) {
    process.stderr.write('No connected Gmail account found.\n');
    process.exitCode = 1;
    return;
  }
  const where = { connected_google_account_id: account.id };
  const takenAt = new Date().toISOString();
  // Resolved from this file, not from the working directory: npm runs workspace scripts with cwd
  // set to the workspace, which would scatter snapshots into apps/api/backups instead of the one
  // place the repository keeps them.
  const backupsRoot = fileURLToPath(new URL('../../../backups', import.meta.url));
  const directory = join(backupsRoot, `pre-pivot-${takenAt.replace(/[:.]/g, '-')}`);
  await mkdir(directory, { recursive: true });

  const tables = {
    user_labels: await prisma.user_labels.findMany({ where }),
    learned_classification_patterns: await prisma.learned_classification_patterns.findMany({
      where,
    }),
    automation_message_actions: await prisma.automation_message_actions.findMany({ where }),
    message_facets: await prisma.message_facets.findMany({ where }),
  };

  // Live, not the stored projection: this list is what the rollback deletes against.
  const gmailLabels = await gmailSyncService.labels(account.user_id);

  const manifest: Record<string, number> = {};
  for (const [name, rows] of Object.entries(tables)) {
    await writeFile(join(directory, `${name}.json`), serialize(rows), 'utf8');
    manifest[name] = rows.length;
  }
  await writeFile(join(directory, 'gmail_labels_live.json'), serialize(gmailLabels), 'utf8');
  manifest['gmail_labels_live'] = gmailLabels.length;

  const mailmindLabels = gmailLabels.filter((label) => label.name?.startsWith('MailMind/'));
  await writeFile(
    join(directory, 'MANIFEST.json'),
    serialize({
      takenAt,
      purpose: 'pre-phase-3 pivot rollback point',
      account: account.email,
      database: 'supabase remote',
      manifest,
      mailmindGmailLabelsBefore: mailmindLabels.length,
    }),
    'utf8',
  );

  write(`Snapshot written to ${directory}`);
  for (const [name, count] of Object.entries(manifest)) {
    write(`  ${name.padEnd(34)} ${count}`);
  }
  write();
  write(
    `${mailmindLabels.length} MailMind/* label(s) exist in Gmail right now. Any MailMind label ` +
      'absent from gmail_labels_live.json after the pivot was created by it.',
  );
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
