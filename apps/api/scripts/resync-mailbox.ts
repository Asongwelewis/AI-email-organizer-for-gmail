/**
 * Sends one mailbox back through first setup, so it is read again over its current history window.
 *
 *   npm run mailbox:resync --workspace @mailmind/api -- someone@example.com
 *
 * For a mailbox set up under an older, narrower window: it keeps everything already stored (the
 * sync upserts), clears the markers that say the first sync and setup are done, and lets the
 * onboarding sweep pick it up within a minute. Nothing is deleted and Gmail is not touched.
 */
import { prisma } from '../src/database/prisma.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !email.includes('@')) {
  console.error('Usage: npm run mailbox:resync -- <mailbox email>');
  process.exit(1);
}

const account = await prisma.connected_google_accounts.findFirst({
  where: { email: { equals: email, mode: 'insensitive' }, gmail_connected: true },
  select: { id: true },
});
if (!account) {
  console.error('No connected mailbox with that address.');
  process.exit(1);
}

await prisma.$transaction([
  prisma.gmail_sync_states.updateMany({
    where: { connected_google_account_id: account.id, lease_token: null },
    data: {
      initial_sync_completed_at: null,
      backfill_started_at: null,
      backfill_completed_at: null,
      backfill_listing_completed_at: null,
      backfill_page_token: null,
      backfill_history_id: null,
      backfill_messages_processed: 0,
      backfill_pages_completed: 0,
      backfill_checkpointed_at: null,
    },
  }),
  prisma.connected_google_accounts.update({
    where: { id: account.id },
    data: { onboarding_stage: null, onboarding_completed_at: null },
  }),
]);
console.log('Setup will run again for that mailbox within a minute.');
await prisma.$disconnect();
