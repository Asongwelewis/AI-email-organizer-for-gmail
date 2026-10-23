/**
 * Rebuilds `reference_classification_rules` from the reference mailbox's checked decisions.
 *
 *   npm run reference:build --workspace @mailmind/api -- owner@example.com [--dry-run]
 *
 * The reference mailbox is named on the command line, never in the repository. Only the rules are
 * written — senders and generic subject phrases with their facets — and nothing that identifies a
 * message. `--dry-run` prints the counts and writes nothing.
 */
import { prisma } from '../src/database/prisma.js';
import {
  DEFAULT_REFERENCE_OPTIONS,
  buildReferenceRules,
  replaceReferenceRules,
} from '../src/features/label-discovery/reference-rules.js';

const email = process.argv[2]?.trim().toLowerCase();
const dryRun = process.argv.includes('--dry-run');
if (!email || !email.includes('@')) {
  console.error('Usage: npm run reference:build -- <reference mailbox email> [--dry-run]');
  process.exit(1);
}

const account = await prisma.connected_google_accounts.findFirst({
  where: { email: { equals: email, mode: 'insensitive' } },
  select: { id: true, users: { select: { display_name: true } } },
});
if (!account) {
  console.error('No connected mailbox with that address.');
  process.exit(1);
}

const decided = await prisma.message_facets.findMany({
  where: {
    connected_google_account_id: account.id,
    message: { deleted_at: null, is_trashed: false, is_draft: false, is_sent: false },
  },
  select: {
    domain: true,
    intent: true,
    message: { select: { subject: true, sender_email: true } },
  },
});

// The owner's own names must never become part of a phrase applied to other people's mail.
const excludedWords = new Set(
  [account.users.display_name ?? '', email.split('@')[0] ?? '']
    .join(' ')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word.length >= 3),
);

const rules = buildReferenceRules(
  decided.map((row) => ({
    subject: row.message.subject,
    senderEmail: row.message.sender_email,
    domain: row.domain,
    intent: row.intent,
  })),
  { ...DEFAULT_REFERENCE_OPTIONS, excludedWords },
);

const senders = rules.filter((rule) => rule.kind === 'SENDER_DOMAIN').length;
console.log(
  `${decided.length} decisions -> ${rules.length} rules (${senders} senders, ${rules.length - senders} phrases)`,
);
if (dryRun) {
  console.log('dry run: nothing written');
} else {
  await replaceReferenceRules(rules);
  console.log('reference rules replaced');
}
await prisma.$disconnect();
