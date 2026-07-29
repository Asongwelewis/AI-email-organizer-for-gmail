import { randomUUID } from 'node:crypto';
import type { gmail_sync_status, gmail_sync_type, Prisma } from '@prisma/client';

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

  markMissingFromBackfill(accountId: string, backfillStartedAt: Date) {
    return prisma.gmail_message_metadata.updateMany({
      where: {
        connected_google_account_id: accountId,
        deleted_at: null,
        last_synced_at: { lt: backfillStartedAt },
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
    await prisma.$transaction(
      labels.map((label) =>
        prisma.gmail_labels.upsert({
          where: {
            connected_google_account_id_gmail_label_id: {
              connected_google_account_id: accountId,
              gmail_label_id: label.id,
            },
          },
          create: {
            connected_google_account_id: accountId,
            gmail_label_id: label.id,
            name: label.name,
            type: label.type,
            message_list_visibility: label.messageListVisibility,
            label_list_visibility: label.labelListVisibility,
            is_managed: label.managedPurpose !== null,
            managed_purpose: label.managedPurpose,
          },
          update: {
            name: label.name,
            type: label.type,
            message_list_visibility: label.messageListVisibility,
            label_list_visibility: label.labelListVisibility,
            is_managed: label.managedPurpose !== null,
            managed_purpose: label.managedPurpose,
          },
        }),
      ),
    );
  }

  async upsertMessages(accountId: string, records: GmailMessageRecord[]): Promise<void> {
    const now = new Date();
    await prisma.$transaction(
      records.map((record) => {
        const data: Prisma.gmail_message_metadataUncheckedCreateInput = {
          connected_google_account_id: accountId,
          ...record,
          last_synced_at: now,
          deleted_at: null,
        };
        return prisma.gmail_message_metadata.upsert({
          where: {
            connected_google_account_id_gmail_message_id: {
              connected_google_account_id: accountId,
              gmail_message_id: record.gmail_message_id,
            },
          },
          create: data,
          update: { ...record, last_synced_at: now, deleted_at: null },
        });
      }),
    );
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
