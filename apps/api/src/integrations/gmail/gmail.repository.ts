import { randomUUID } from 'node:crypto';
import type { gmail_sync_status, gmail_sync_type } from '@prisma/client';

import { env } from '@api/config/env.js';
import { prisma } from '@api/database/prisma.js';
import { AppError } from '@api/errors/AppError.js';
import type { GmailMessageRecord, SyncCounts } from './gmail.types.js';

export interface SyncLease {
  accountId: string;
  token: string;
  runId: string;
}

export class GmailRepository {
  async activeAccountForUser(userId: string) {
    const account = await prisma.connected_google_accounts.findFirst({
      where: { user_id: userId, gmail_connected: true, connection_status: 'CONNECTED' },
      orderBy: { updated_at: 'desc' },
    });
    if (!account) {
      throw new AppError(
        'GMAIL_ACCOUNT_NOT_CONNECTED',
        'Connect Gmail before using synchronization.',
        409,
      );
    }
    return account;
  }

  async acquireLease(
    accountId: string,
    status: gmail_sync_status,
    syncType: gmail_sync_type,
  ): Promise<SyncLease> {
    await prisma.gmail_sync_states.upsert({
      where: { connected_google_account_id: accountId },
      create: { connected_google_account_id: accountId },
      update: {},
    });
    const token = randomUUID();
    const now = new Date();
    const acquired = await prisma.gmail_sync_states.updateMany({
      where: {
        connected_google_account_id: accountId,
        OR: [{ lease_expires_at: null }, { lease_expires_at: { lt: now } }],
      },
      data: {
        status,
        lease_token: token,
        lease_expires_at: new Date(now.getTime() + env.GMAIL_SYNC_LEASE_SECONDS * 1000),
        last_sync_started_at: now,
        last_error_code: null,
        last_error_at: null,
      },
    });
    if (acquired.count !== 1) {
      throw new AppError(
        'GMAIL_SYNC_ALREADY_RUNNING',
        'A Gmail operation is already running for this account.',
        409,
      );
    }
    await prisma.gmail_sync_runs.updateMany({
      where: { connected_google_account_id: accountId, status: 'RUNNING' },
      data: {
        status: 'FAILED',
        completed_at: now,
        error_code: 'STALE_SYNC_LEASE_RECOVERED',
      },
    });
    const run = await prisma.gmail_sync_runs.create({
      data: { connected_google_account_id: accountId, sync_type: syncType },
    });
    return { accountId, token, runId: run.id };
  }

  async renewLease(lease: SyncLease): Promise<void> {
    const renewed = await prisma.gmail_sync_states.updateMany({
      where: {
        connected_google_account_id: lease.accountId,
        lease_token: lease.token,
        lease_expires_at: { gt: new Date() },
      },
      data: {
        lease_expires_at: new Date(Date.now() + env.GMAIL_SYNC_LEASE_SECONDS * 1000),
      },
    });
    if (renewed.count !== 1) {
      throw new AppError(
        'GMAIL_SYNC_ALREADY_RUNNING',
        'The Gmail operation lease expired or was replaced.',
        409,
      );
    }
  }

  async beginBackfill(lease: SyncLease, totalGmailMessages: number, historyId: string | null) {
    const current = await this.state(lease.accountId);
    const resumable = Boolean(
      current?.backfill_started_at && !current.backfill_completed_at && current.backfill_history_id,
    );
    const startedAt = new Date();
    const updated = await prisma.gmail_sync_states.updateMany({
      where: {
        connected_google_account_id: lease.accountId,
        lease_token: lease.token,
      },
      data: resumable
        ? { total_gmail_messages: totalGmailMessages }
        : {
            total_gmail_messages: totalGmailMessages,
            backfill_page_token: null,
            backfill_history_id: historyId,
            backfill_messages_processed: 0,
            backfill_pages_completed: 0,
            backfill_started_at: startedAt,
            backfill_checkpointed_at: null,
            backfill_listing_completed_at: null,
            backfill_completed_at: null,
          },
    });
    if (updated.count !== 1) {
      throw new AppError(
        'GMAIL_SYNC_ALREADY_RUNNING',
        'The Gmail operation lease expired or was replaced.',
        409,
      );
    }
    return (await this.state(lease.accountId))!;
  }

  async checkpointBackfillPage(
    lease: SyncLease,
    nextPageToken: string | null,
    messagesProcessed: number,
  ): Promise<void> {
    const checkpointed = await prisma.gmail_sync_states.updateMany({
      where: {
        connected_google_account_id: lease.accountId,
        lease_token: lease.token,
      },
      data: {
        backfill_page_token: nextPageToken,
        backfill_messages_processed: { increment: messagesProcessed },
        backfill_pages_completed: { increment: 1 },
        backfill_checkpointed_at: new Date(),
        ...(nextPageToken ? {} : { backfill_listing_completed_at: new Date() }),
      },
    });
    if (checkpointed.count !== 1) {
      throw new AppError(
        'GMAIL_SYNC_ALREADY_RUNNING',
        'The Gmail operation lease expired or was replaced.',
        409,
      );
    }
  }

  async updateMailboxTotal(lease: SyncLease, totalGmailMessages: number): Promise<void> {
    const updated = await prisma.gmail_sync_states.updateMany({
      where: {
        connected_google_account_id: lease.accountId,
        lease_token: lease.token,
      },
      data: { total_gmail_messages: totalGmailMessages },
    });
    if (updated.count !== 1) {
      throw new AppError(
        'GMAIL_SYNC_ALREADY_RUNNING',
        'The Gmail operation lease expired or was replaced.',
        409,
      );
    }
  }

  markMissingFromBackfill(accountId: string, backfillStartedAt: Date, since: Date | null = null) {
    return prisma.gmail_message_metadata.updateMany({
      where: {
        connected_google_account_id: accountId,
        deleted_at: null,
        last_synced_at: { lt: backfillStartedAt },
        ...(since ? { internal_date: { gte: since } } : {}),
      },
      data: { deleted_at: new Date() },
    });
  }

  async complete(
    lease: SyncLease,
    counts: SyncCounts,
    checkpoint: string | null,
    initial: boolean,
  ): Promise<void> {
    const now = new Date();
    await prisma.$transaction(async (transaction) => {
      const completed = await transaction.gmail_sync_states.updateMany({
        where: {
          connected_google_account_id: lease.accountId,
          lease_token: lease.token,
        },
        data: {
          status: 'READY',
          ...(checkpoint ? { last_history_id: checkpoint } : {}),
          ...(initial
            ? {
                initial_sync_completed_at: now,
                backfill_page_token: null,
                backfill_completed_at: now,
                backfill_checkpointed_at: now,
              }
            : {}),
          last_sync_completed_at: now,
          last_successful_sync_at: now,
          failure_count: 0,
          next_retry_at: null,
          last_error_code: null,
          last_error_at: null,
          lease_token: null,
          lease_expires_at: null,
        },
      });
      if (completed.count !== 1) {
        throw new AppError(
          'GMAIL_SYNC_ALREADY_RUNNING',
          'The Gmail operation lease expired or was replaced.',
          409,
        );
      }
      await transaction.gmail_sync_runs.update({
        where: { id: lease.runId },
        data: {
          status: 'COMPLETED',
          completed_at: now,
          messages_examined: counts.messagesExamined,
          messages_upserted: counts.messagesUpserted,
          messages_deleted: counts.messagesDeleted,
          labels_upserted: counts.labelsUpserted,
          checkpoint_history_id: checkpoint,
        },
      });
    });
  }

  async fail(lease: SyncLease, code: string): Promise<void> {
    const now = new Date();
    const status =
      code === 'GMAIL_REAUTH_REQUIRED'
        ? 'REAUTH_REQUIRED'
        : code === 'GMAIL_HISTORY_EXPIRED'
          ? 'HISTORY_EXPIRED'
          : 'FAILED';
    await prisma.$transaction([
      prisma.gmail_sync_states.updateMany({
        where: {
          connected_google_account_id: lease.accountId,
          lease_token: lease.token,
        },
        data: {
          status,
          failure_count: { increment: 1 },
          last_error_code: code,
          last_error_at: now,
          next_retry_at:
            code === 'GMAIL_RATE_LIMITED' || code === 'GMAIL_UPSTREAM_UNAVAILABLE'
              ? new Date(now.getTime() + 60_000)
              : null,
          lease_token: null,
          lease_expires_at: null,
        },
      }),
      prisma.gmail_sync_runs.update({
        where: { id: lease.runId },
        data: { status: 'FAILED', completed_at: now, error_code: code },
      }),
    ]);
  }

  /**
   * One statement for the whole set. Each upsert used to be its own round trip inside one
   * transaction — about 150ms apiece between Render and Supabase — so a mailbox with sixty labels
   * spent nine seconds here before a single message was read.
   */
  async upsertLabels(
    accountId: string,
    labels: Array<{
      id: string;
      name: string;
      type: string;
      messageListVisibility: string | null;
      labelListVisibility: string | null;
      managedPurpose: string | null;
    }>,
  ): Promise<void> {
    const rows = [...new Map(labels.map((label) => [label.id, label])).values()];
    if (rows.length === 0) return;
    const payload = JSON.stringify(
      rows.map((label) => ({
        gmail_label_id: label.id,
        name: label.name,
        type: label.type,
        message_list_visibility: label.messageListVisibility,
        label_list_visibility: label.labelListVisibility,
        is_managed: label.managedPurpose !== null,
        managed_purpose: label.managedPurpose,
      })),
    );
    await prisma.$executeRaw`
      insert into public.gmail_labels (
        connected_google_account_id, gmail_label_id, name, type, message_list_visibility,
        label_list_visibility, is_managed, managed_purpose
      )
      select ${accountId}::uuid, r.gmail_label_id, r.name, r.type, r.message_list_visibility,
        r.label_list_visibility, r.is_managed, r.managed_purpose
      from jsonb_to_recordset(${payload}::jsonb) as r(
        gmail_label_id text, name text, type text, message_list_visibility text,
        label_list_visibility text, is_managed boolean, managed_purpose text
      )
      on conflict (connected_google_account_id, gmail_label_id) do update set
        name = excluded.name,
        type = excluded.type,
        message_list_visibility = excluded.message_list_visibility,
        label_list_visibility = excluded.label_list_visibility,
        is_managed = excluded.is_managed,
        managed_purpose = excluded.managed_purpose
    `;
  }

  /**
   * Writes a page of messages in one statement.
   *
   * This was one `upsert` per message inside a transaction, which Prisma sends as a SELECT and an
   * INSERT or UPDATE each: twenty round trips for a batch of ten, at 100-150ms apiece from Render
   * to Supabase. Sentry flagged it as an N+1, and it was most of the time a first sync took. The
   * rows travel as one JSON array and Postgres unpacks them, so a batch costs one trip whatever
   * its size. A message listed twice in one batch keeps its last copy: `on conflict` refuses to
   * touch the same row twice in a statement.
   */
  async upsertMessages(accountId: string, records: GmailMessageRecord[]): Promise<void> {
    const rows = [...new Map(records.map((record) => [record.gmail_message_id, record])).values()];
    if (rows.length === 0) return;
    const payload = JSON.stringify(rows);
    const now = new Date();
    await prisma.$executeRaw`
      insert into public.gmail_message_metadata (
        connected_google_account_id, gmail_message_id, gmail_thread_id, history_id, internal_date,
        subject, sender_name, sender_email, recipient_summary, snippet, label_ids,
        has_attachments, size_estimate, is_unread, is_starred, is_important, is_draft, is_sent,
        is_trashed, last_synced_at, deleted_at
      )
      select ${accountId}::uuid, r.gmail_message_id, r.gmail_thread_id, r.history_id,
        r.internal_date, r.subject, r.sender_name, r.sender_email, r.recipient_summary, r.snippet,
        coalesce(r.label_ids, '{}'), r.has_attachments, r.size_estimate, r.is_unread,
        r.is_starred, r.is_important, r.is_draft, r.is_sent, r.is_trashed, ${now}, null
      from jsonb_to_recordset(${payload}::jsonb) as r(
        gmail_message_id text, gmail_thread_id text, history_id text, internal_date timestamptz,
        subject text, sender_name text, sender_email text, recipient_summary text, snippet text,
        label_ids text[], has_attachments boolean, size_estimate integer, is_unread boolean,
        is_starred boolean, is_important boolean, is_draft boolean, is_sent boolean,
        is_trashed boolean
      )
      on conflict (connected_google_account_id, gmail_message_id) do update set
        gmail_thread_id = excluded.gmail_thread_id,
        history_id = excluded.history_id,
        internal_date = excluded.internal_date,
        subject = excluded.subject,
        sender_name = excluded.sender_name,
        sender_email = excluded.sender_email,
        recipient_summary = excluded.recipient_summary,
        snippet = excluded.snippet,
        label_ids = excluded.label_ids,
        has_attachments = excluded.has_attachments,
        size_estimate = excluded.size_estimate,
        is_unread = excluded.is_unread,
        is_starred = excluded.is_starred,
        is_important = excluded.is_important,
        is_draft = excluded.is_draft,
        is_sent = excluded.is_sent,
        is_trashed = excluded.is_trashed,
        last_synced_at = excluded.last_synced_at,
        deleted_at = null
    `;
  }

  markDeleted(accountId: string, messageIds: string[]) {
    if (messageIds.length === 0) return Promise.resolve({ count: 0 });
    return prisma.gmail_message_metadata.updateMany({
      where: {
        connected_google_account_id: accountId,
        gmail_message_id: { in: messageIds },
      },
      data: { deleted_at: new Date(), last_synced_at: new Date() },
    });
  }

  state(accountId: string) {
    return prisma.gmail_sync_states.findUnique({
      where: { connected_google_account_id: accountId },
    });
  }

  countMessages(accountId: string) {
    return prisma.gmail_message_metadata.count({
      where: { connected_google_account_id: accountId, deleted_at: null },
    });
  }

  async coverage(accountId: string) {
    // Automation is the only classifier, so its message actions define processed coverage.
    const [syncedMessages, classifiedMessages] = await Promise.all([
      this.countMessages(accountId),
      prisma.automation_message_actions.count({
        where: {
          connected_google_account_id: accountId,
          status: { in: ['APPLIED', 'REVIEW_REQUIRED', 'SKIPPED'] },
          message: { deleted_at: null },
        },
      }),
    ]);
    return {
      syncedMessages,
      classifiedMessages,
      unprocessedMessages: Math.max(0, syncedMessages - classifiedMessages),
    };
  }
}

export const gmailRepository = new GmailRepository();
