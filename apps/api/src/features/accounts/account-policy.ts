import { env } from '@api/config/env.js';
import { prisma } from '@api/database/prisma.js';
import { AppError } from '@api/errors/AppError.js';

/**
 * What one mailbox is allowed: whether it is sorted with Gemini, and how far back its mail goes.
 *
 * Two kinds of mailbox exist. The operator's (`OWNER_ACCOUNT_EMAILS`) is sorted by Gemini over its
 * whole history. Everyone else is sorted by rules and Gmail's own categories, inside a window of
 * `MAIL_HISTORY_DAYS` counted back from when their mailbox was first connected — and none of
 * their mail is ever sent to a model. That is a privacy line as much as a cost one: Google's
 * Limited Use rules forbid handing Gmail data to a service that may learn from it, which the free
 * Gemini tier does.
 *
 * Every path that could cross either line asks here: sync, classification, the AI-backed planning
 * features, and housekeeping. None of them decides for itself.
 */

export type ClassificationMode = 'MODEL' | 'RULES';

export interface AccountPolicy {
  owner: boolean;
  mode: ClassificationMode;
  /** The oldest mail this mailbox may hold or have sorted; null for no limit. */
  windowStart: Date | null;
}

interface PolicyAccount {
  email: string;
  created_at: Date;
  mail_history_days: number | null;
}

const DAY_MS = 86_400_000;

export function isOwnerEmail(email: string): boolean {
  return env.OWNER_ACCOUNT_EMAILS.includes(email.trim().toLowerCase());
}

/**
 * Pure, so every caller and every test computes the same answer from the same row. The window is
 * anchored on the mailbox's FIRST connection, not the latest: reconnecting must not slide it.
 */
export function policyFor(account: PolicyAccount): AccountPolicy {
  if (isOwnerEmail(account.email)) {
    return { owner: true, mode: env.GEMINI_API_KEY ? 'MODEL' : 'RULES', windowStart: null };
  }
  const days = account.mail_history_days ?? env.MAIL_HISTORY_DAYS;
  return {
    owner: false,
    mode: 'RULES',
    windowStart: new Date(account.created_at.getTime() - days * DAY_MS),
  };
}

const CACHE_MS = 60_000;
const cache = new Map<string, { policy: AccountPolicy; at: number }>();

/** The policy for an account id, read once a minute at most. */
export async function policyForAccount(accountId: string): Promise<AccountPolicy> {
  const cached = cache.get(accountId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.policy;
  const account = await prisma.connected_google_accounts.findUnique({
    where: { id: accountId },
    select: { email: true, created_at: true, mail_history_days: true },
  });
  // An account that cannot be read gets the narrowest policy there is, never the widest.
  const policy = account
    ? policyFor(account)
    : { owner: false, mode: 'RULES' as const, windowStart: new Date() };
  cache.set(accountId, { policy, at: Date.now() });
  return policy;
}

/**
 * Refuses an AI-backed feature for a mailbox the model may not see. Proposing a folder tree or a
 * vocabulary sends a sample of the mailbox to Gemini, which is exactly what only the owner's may
 * have done to it.
 */
export async function assertModelAllowed(accountId: string): Promise<void> {
  const policy = await policyForAccount(accountId);
  if (policy.mode !== 'MODEL') {
    throw new AppError(
      'AI_FEATURE_UNAVAILABLE',
      'This feature is not available on your plan. Your mail is still sorted automatically.',
      403,
    );
  }
}

/** Test seam. */
export function forgetAccountPolicies(): void {
  cache.clear();
}

export interface AccountPolicySource {
  forAccount(accountId: string): Promise<AccountPolicy>;
}

export const accountPolicies: AccountPolicySource = { forAccount: policyForAccount };
