/**
 * Reads what people have sent through the feedback form.
 *
 * Deliberately a script rather than a screen. There is no admin role in this system — every
 * authenticated person is an equal user of their own mailbox — so an authenticated `GET
 * /api/feedback` would let anyone who signed in read everybody's feedback, including the contact
 * addresses people left expecting a private reply. Adding a role to the model to support one
 * read-only list is the larger change; a script that runs against the database with the
 * credentials only the operator has is the smaller one.
 *
 *   npm run feedback --workspace @mailmind/api                  # the 20 most recent
 *   npm run feedback --workspace @mailmind/api -- --limit 100
 *   npm run feedback --workspace @mailmind/api -- --kind PROBLEM
 *   npm run feedback --workspace @mailmind/api -- --unanswered   # only ones that left an address
 */
import type { feedback_kind } from '@prisma/client';

import { prisma } from '../src/database/prisma.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const KINDS = ['PROBLEM', 'IDEA', 'PRAISE', 'OTHER'] as const;
const limit = Number(flag('limit') ?? 20);
const kind = flag('kind')?.toUpperCase();
const contactableOnly = args.includes('--unanswered');

const write = (line = '') => process.stdout.write(`${line}\n`);

async function main(): Promise<void> {
  if (!Number.isFinite(limit) || limit < 1 || limit > 500) {
    throw new Error('--limit must be between 1 and 500.');
  }
  if (kind && !KINDS.includes(kind as feedback_kind)) {
    throw new Error(`--kind must be one of ${KINDS.join(', ')}.`);
  }

  const rows = await prisma.feedback.findMany({
    where: {
      ...(kind ? { kind: kind as feedback_kind } : {}),
      ...(contactableOnly ? { contact: { not: null } } : {}),
    },
    orderBy: { created_at: 'desc' },
    take: limit,
    // The submitter's own email, only when they chose to leave one; the account email is not it.
    include: { users: { select: { email: true } } },
  });

  const total = await prisma.feedback.count();
  write(`${rows.length} of ${total} submission(s), newest first.\n`);

  if (rows.length === 0) {
    write('Nothing yet.');
    return;
  }

  for (const row of rows) {
    const when = row.created_at.toISOString().replace('T', ' ').slice(0, 16);
    const who = row.users?.email ?? 'not signed in';
    write(`${'─'.repeat(78)}`);
    write(`${row.kind.padEnd(8)} ${when}  ${who}${row.page ? `  on ${row.page}` : ''}`);
    if (row.contact) write(`reply to: ${row.contact}`);
    write();
    // Indented rather than raw: a submission is arbitrary text and may contain anything that
    // would otherwise be mistaken for this script's own output.
    for (const line of row.message.split('\n')) write(`  ${line}`);
    write();
  }
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
