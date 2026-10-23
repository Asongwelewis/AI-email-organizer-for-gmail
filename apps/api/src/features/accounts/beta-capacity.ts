import { env } from '@api/config/env.js';
import { prisma } from '@api/database/prisma.js';
import { isOwnerEmail } from './account-policy.js';

/**
 * Whether one more mailbox may be connected.
 *
 * The free Render instance and the free database are sized for a small beta, so the number of
 * connected mailboxes other than the owner's is capped at BETA_MAX_MAILBOXES. The check sits in
 * front of Google's consent screen: someone past the cap is told the beta is full before they are
 * asked for anything, rather than after granting access to a mailbox that will never be read.
 *
 * Reconnecting is never refused — a person already in the beta keeps their place — and neither is
 * the owner. Two people racing for the last place can both pass; at a cap of ten that is one
 * mailbox over, and it is the honest price of not taking a lock on every sign-in.
 */
export async function mayConnectMailbox(userId: string, userEmail: string): Promise<boolean> {
  if (isOwnerEmail(userEmail)) return true;
  const own = await prisma.connected_google_accounts.count({ where: { user_id: userId } });
  if (own > 0) return true;
  const taken = await prisma.connected_google_accounts.count({
    where: {
      gmail_connected: true,
      ...(env.OWNER_ACCOUNT_EMAILS.length > 0
        ? { NOT: { email: { in: env.OWNER_ACCOUNT_EMAILS, mode: 'insensitive' as const } } }
        : {}),
    },
  });
  return taken < env.BETA_MAX_MAILBOXES;
}
