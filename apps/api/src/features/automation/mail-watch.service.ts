import type { gmail_message_metadata } from '@prisma/client';

import { env } from '@api/config/env.js';
import { logger, safeErrorDetails } from '@api/config/logger.js';
import { prisma } from '@api/database/prisma.js';
import { AppError } from '@api/errors/AppError.js';
import { gmailSyncService } from '@api/integrations/gmail/gmail.service.js';
import {
  notificationsService,
  type NotificationsService,
} from '@api/features/notifications/notifications.service.js';
import {
  NEW_MAIL_WINDOW_MS,
  facetClassificationService,
  type FacetClassificationService,
} from './facet-classification.service.js';
import { recordDailyUsage } from './usage-ledger.js';

/**
 * Sorts new mail as it arrives, between the full runs.
 *
 * A full run is the whole job — the backlog, re-classification, filing — and it happens twice a
 * day. Someone who gets mail every minute should not wait half a day to see it in its folder, so
 * every minute this asks Gmail one question: has anything changed? Almost always the answer is no,
 * and nothing else happens. When it is yes, the new mail is synced, the rules sort what they
 * recognise at once, and the rest waits for Gemini until enough has queued to be worth one call.
 *
 * It never touches the backlog. Mail older than NEW_MAIL_WINDOW_MS belongs to the full runs, so a
 * freshly connected mailbox's thousands of unsorted messages cannot spend the free tier's daily
 * requests ten at a time.
 */

/** How many new messages one check will sort. A check is meant to be quick. */
const CHECK_LIMIT = 50;

/**
 * A ceiling on one pass, far above the several hundred mailboxes this is sized for. A pass is
 * parallel (AUTOMATION_WATCH_CONCURRENCY) and almost every check is one Gmail call, so this many
 * still fits comfortably inside a minute.
 */
const MAX_WATCHED_ACCOUNTS = 5000;

/** Errors that mean "not this time", not "something is broken". */
const SKIPPABLE = new Set([
  'GMAIL_SYNC_ALREADY_RUNNING',
  'GMAIL_INITIAL_SYNC_REQUIRED',
  'GMAIL_HISTORY_EXPIRED',
  'AUTOMATION_ALREADY_RUNNING',
  'FACET_VOCABULARY_NOT_APPROVED',
]);

/** After a real failure an account is left alone for a while, doubling up to this. */
const MAX_BACKOFF_MS = 30 * 60_000;

export interface WatchOutcome {
  outcome: 'UNCHANGED' | 'CHECKED' | 'SKIPPED' | 'BACKING_OFF';
  reason?: string;
  synced?: number;
  sorted?: number;
  deferred?: number;
  /** New messages announced in the app and, where subscribed, on the person's devices. */
  announced?: number;
}

export class MailWatchService {
  private readonly backoff = new Map<string, { failures: number; until: number }>();
  /**
   * When each mailbox was last asked "anything new?". In memory on purpose: it is what the panel
   * shows as "last checked", a check that finds nothing writes nothing, and on the one free
   * instance this runs on, a restart losing it only means the panel falls back to the last sync.
   */
  private readonly checkedAt = new Map<string, Date>();

  lastCheckedAt(accountId: string): Date | undefined {
    return this.checkedAt.get(accountId);
  }

  constructor(
    private readonly gmail: Pick<
      typeof gmailSyncService,
      'hasNewHistory' | 'incrementalSync'
    > = gmailSyncService,
    private readonly classification: Pick<
      FacetClassificationService,
      'classifyAccount'
    > = facetClassificationService,
    private readonly notifier: Pick<NotificationsService, 'recordNewMail'> = notificationsService,
  ) {}

  /**
   * Mailboxes worth watching: connected, not paused, past their first sync, and onboarded. Until
   * onboarding has finished it owns the mailbox — two writers on a first sync would only contend
   * for the same leases, and the person is watching onboarding's progress bar, not this.
   *
   * Every one of them, not the first fifty: the cap that used to be here meant the fifty-first
   * person to sign up was never watched at all. The scheduler checks them in parallel.
   */
  eligibleAccounts() {
    return prisma.connected_google_accounts.findMany({
      where: {
        gmail_connected: true,
        connection_status: 'CONNECTED',
        onboarding_completed_at: { not: null },
        gmail_sync_state: { is: { initial_sync_completed_at: { not: null } } },
        OR: [{ automation_settings: null }, { automation_settings: { is: { enabled: true } } }],
      },
      select: { id: true, user_id: true },
      orderBy: { id: 'asc' },
      take: MAX_WATCHED_ACCOUNTS,
    });
  }

  async check(accountId: string, userId: string, now = Date.now()): Promise<WatchOutcome> {
    const backoff = this.backoff.get(accountId);
    if (backoff && backoff.until > now) return { outcome: 'BACKING_OFF' };
    try {
      const outcome = await this.checkOnce(accountId, userId, now);
      this.backoff.delete(accountId);
      const announced = await this.announce(accountId, now);
      return announced > 0 ? { ...outcome, announced } : outcome;
    } catch (error) {
      if (error instanceof AppError && SKIPPABLE.has(error.code)) {
        return { outcome: 'SKIPPED', reason: error.code };
      }
      // Once a minute is often enough to turn one broken account into a flood of identical
      // errors, so a failing account backs off: one minute, two, four, up to thirty.
      const failures = (backoff?.failures ?? 0) + 1;
      this.backoff.set(accountId, {
        failures,
        until: now + Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** (failures - 1)),
      });
      throw error;
    }
  }

  private async checkOnce(accountId: string, userId: string, now: number): Promise<WatchOutcome> {
    // A full run is already doing this and more. Two writers on one mailbox would only contend
    // for the same leases.
    if (await this.fullRunInProgress(accountId, now)) {
      return { outcome: 'SKIPPED', reason: 'FULL_RUN_IN_PROGRESS' };
    }

    let synced = 0;
    const changed = await this.gmail.hasNewHistory(userId);
    this.checkedAt.set(accountId, new Date(now));
    if (changed) {
      const result = await this.gmail.incrementalSync(userId);
      synced = result.messagesUpserted;
    }

    // Mail can be waiting with nothing new in Gmail: the rules left it for Gemini and the batch
    // was not worth a call yet. Without this, it would wait for the next new message to arrive.
    if (!changed && (await this.waitingCount(accountId, now)) === 0) {
      return { outcome: 'UNCHANGED' };
    }

    const counters = await this.classification.classifyAccount(accountId, {
      scope: 'new',
      limit: CHECK_LIMIT,
      modelGate: (undecided) => this.worthACall(undecided, now),
    });
    await recordDailyUsage(accountId, 'watch', counters);
    return {
      outcome: 'CHECKED',
      synced,
      sorted: counters.ruleDecided + counters.modelDecided,
      deferred: counters.deferred,
    };
  }

  /**
   * Announces whatever new mail has been stored since the last check — by this check, by a full
   * run, by anything. Asked every tick, after sorting, so a notification can name the folder. It
   * never fails the check: mail sorted and not announced is better than mail not sorted.
   */
  private async announce(accountId: string, now: number): Promise<number> {
    try {
      return await this.notifier.recordNewMail(accountId, now);
    } catch (error) {
      logger.warn({ ...safeErrorDetails(error), accountId }, 'new-mail notification failed');
      return 0;
    }
  }

  /** Enough queued for one call to sort a batch, or someone has waited long enough. */
  worthACall(undecided: gmail_message_metadata[], now = Date.now()): boolean {
    if (undecided.length >= env.AUTOMATION_CLASSIFY_BATCH_THRESHOLD) return true;
    const maxWaitMs = env.AUTOMATION_CLASSIFY_MAX_WAIT_MINUTES * 60_000;
    return undecided.some((message) => now - message.created_at.getTime() >= maxWaitMs);
  }

  private waitingCount(accountId: string, now: number): Promise<number> {
    return prisma.gmail_message_metadata.count({
      where: {
        connected_google_account_id: accountId,
        deleted_at: null,
        is_draft: false,
        is_sent: false,
        is_trashed: false,
        facets: null,
        internal_date: { gte: new Date(now - NEW_MAIL_WINDOW_MS) },
        NOT: { label_ids: { hasSome: ['SPAM', 'TRASH', 'DRAFT'] } },
      },
    });
  }

  private async fullRunInProgress(accountId: string, now: number): Promise<boolean> {
    const running = await prisma.activity_runs.count({
      where: {
        connected_google_account_id: accountId,
        kind: 'AUTOMATION_FILING',
        state: 'RUNNING',
        expires_at: { gt: new Date(now) },
      },
    });
    return running > 0;
  }
}

export const mailWatchService = new MailWatchService();
