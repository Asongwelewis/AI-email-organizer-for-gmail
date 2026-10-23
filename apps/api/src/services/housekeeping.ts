import { env } from '@api/config/env.js';
import { logger, safeErrorDetails } from '@api/config/logger.js';
import { prisma } from '@api/database/prisma.js';
import { policyFor } from '@api/features/accounts/account-policy.js';

/**
 * Deletes rows that have stopped meaning anything.
 *
 * With one mailbox nothing here was worth a timer: a few hundred dead sessions and run records cost
 * nothing. With several hundred, the watcher, the onboarding runs and every sign-in each leave rows
 * behind, all of it inside a 500 MB free database that also holds everybody's mail metadata. Every
 * table below is either a record of something finished or a credential that can no longer be used.
 *
 * Audit logs are deliberately not here: they are the security record, and a security record that
 * cleans itself up is not one. Every statement is an idempotent delete by age, so instances that
 * run it at the same time only repeat each other's work.
 */

const DAY_MS = 86_400_000;

/** A dead session is kept a week, so "signed out because it expired" can still be looked up. */
const SESSION_GRACE_DAYS = 7;

let timer: NodeJS.Timeout | null = null;
let firstRun: NodeJS.Timeout | null = null;

export interface HousekeepingResult {
  sessions: number;
  oauthStates: number;
  rateLimitHits: number;
  notifications: number;
  activityRuns: number;
  syncRuns: number;
  /** Stored mail found older than its mailbox's history window, and removed. */
  outsideWindow: number;
}

export async function runHousekeeping(now = new Date()): Promise<HousekeepingResult> {
  const sessionCutoff = new Date(now.getTime() - SESSION_GRACE_DAYS * DAY_MS);
  const retentionCutoff = new Date(now.getTime() - env.HOUSEKEEPING_RETENTION_DAYS * DAY_MS);
  const [sessions, oauthStates, rateLimitHits, notifications, activityRuns, syncRuns] =
    await Promise.all([
      prisma.sessions.deleteMany({
        where: {
          OR: [{ expires_at: { lt: sessionCutoff } }, { revoked_at: { lt: sessionCutoff } }],
        },
      }),
      prisma.oauth_states.deleteMany({
        where: { expires_at: { lt: new Date(now.getTime() - DAY_MS) } },
      }),
      prisma.rate_limit_hits.deleteMany({ where: { expires_at: { lt: now } } }),
      prisma.notifications.deleteMany({ where: { created_at: { lt: retentionCutoff } } }),
      prisma.activity_runs.deleteMany({
        where: { state: { not: 'RUNNING' }, finished_at: { lt: retentionCutoff } },
      }),
      prisma.gmail_sync_runs.deleteMany({
        where: { status: { not: 'RUNNING' }, started_at: { lt: retentionCutoff } },
      }),
    ]);
  const outsideWindow = await purgeOutsideWindows();
  return {
    sessions: sessions.count,
    oauthStates: oauthStates.count,
    rateLimitHits: rateLimitHits.count,
    notifications: notifications.count,
    activityRuns: activityRuns.count,
    syncRuns: syncRuns.count,
    outsideWindow,
  };
}

/**
 * The last of three guards on a mailbox's history window, after the sync (which never asks for
 * older mail and never stores it) and the classifier (which never reads it). Anything that got in
 * anyway — mail stored before the window existed, or a window a plan change shortened — is removed
 * here, with its facets and notifications by cascade. The owner's mailbox has no window.
 */
async function purgeOutsideWindows(): Promise<number> {
  // Deleting mail is the one irreversible thing this file does. With no owner configured, the
  // owner's own mailbox would look like a beta mailbox and lose everything older than its window,
  // so an unconfigured deployment deletes nothing and says so.
  if (env.OWNER_ACCOUNT_EMAILS.length === 0) {
    logger.warn(
      'OWNER_ACCOUNT_EMAILS is not set: mail outside history windows is not being removed',
    );
    return 0;
  }
  const accounts = await prisma.connected_google_accounts.findMany({
    select: { id: true, email: true, created_at: true, mail_history_days: true },
  });
  let removed = 0;
  for (const account of accounts) {
    const { windowStart } = policyFor(account);
    if (!windowStart) continue;
    const deleted = await prisma.gmail_message_metadata.deleteMany({
      where: { connected_google_account_id: account.id, internal_date: { lt: windowStart } },
    });
    removed += deleted.count;
  }
  return removed;
}

async function sweep(): Promise<void> {
  try {
    const result = await runHousekeeping();
    logger.info(result, 'housekeeping finished');
  } catch (error) {
    // Housekeeping that fails today succeeds tomorrow; nothing depends on it running on time.
    logger.warn(safeErrorDetails(error), 'housekeeping failed');
  }
}

/** Every six hours, starting a few minutes after boot so it never competes with a cold start. */
export function startHousekeeping(intervalHours = 6): void {
  if (timer || env.NODE_ENV === 'test') return;
  firstRun = setTimeout(() => void sweep(), 5 * 60_000);
  firstRun.unref();
  timer = setInterval(() => void sweep(), intervalHours * 3_600_000);
  timer.unref();
}

export function stopHousekeeping(): void {
  if (timer) clearInterval(timer);
  if (firstRun) clearTimeout(firstRun);
  timer = null;
  firstRun = null;
}
