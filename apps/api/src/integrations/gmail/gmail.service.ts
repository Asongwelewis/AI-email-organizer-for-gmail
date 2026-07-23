import type { gmail_v1 } from 'googleapis';

import { env } from '@api/config/env.js';
import { AppError } from '@api/errors/AppError.js';
import { connectedGoogleAccountRepository } from '@api/repositories/connected-google-account.repository.js';
import { createGmailClient, withGmailRetry } from './gmail.client.js';
import { classifyGmailError, isHistoryExpired } from './gmail.errors.js';
import { mapGmailMessage } from './gmail.mapper.js';
import { gmailRepository, type SyncLease } from './gmail.repository.js';
import { emptySyncCounts, type GmailClient, type SyncCounts } from './gmail.types.js';

const MANAGED_LABELS = [
  { name: 'MailMind', purpose: 'ROOT' },
  { name: 'MailMind/Processed', purpose: 'PROCESSED' },
  { name: 'MailMind/Needs Review', purpose: 'NEEDS_REVIEW' },
] as const;
const METADATA_HEADERS = ['Subject', 'From', 'To', 'Cc', 'Date'];

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

export class GmailSyncService {
  async profile(userId: string) {
    const account = await gmailRepository.activeAccountForUser(userId);
    const gmail = await createGmailClient(account.id);
    const profile = await this.loadAndValidateProfile(gmail, account.email);
    return {
      emailAddress: profile.emailAddress ?? account.email,
      messagesTotal: profile.messagesTotal ?? 0,
      threadsTotal: profile.threadsTotal ?? 0,
      historyId: profile.historyId ?? null,
    };
  }

  async labels(userId: string) {
    const account = await gmailRepository.activeAccountForUser(userId);
    const gmail = await createGmailClient(account.id);
    const labels = await this.listLabels(gmail);
    return labels.map((label) => ({
      id: label.id,
      name: label.name,
      type: label.type,
      managed: MANAGED_LABELS.some((managed) => managed.name === label.name),
    }));
  }

  async initializeLabels(userId: string) {
    const account = await gmailRepository.activeAccountForUser(userId);
    const lease = await gmailRepository.acquireLease(account.id, 'LABEL_SYNC_RUNNING', 'LABELS');
    const counts = emptySyncCounts();
    try {
      const gmail = await createGmailClient(account.id);
      await this.loadAndValidateProfile(gmail, account.email);
      counts.labelsUpserted = await this.synchronizeLabels(gmail, account.id);
      await gmailRepository.complete(lease, counts, null, false);
      return { success: true, labelsUpserted: counts.labelsUpserted };
    } catch (error) {
      await this.recordFailure(lease, error);
      throw classifyGmailError(error);
    }
  }

  async initialSync(userId: string) {
    const account = await gmailRepository.activeAccountForUser(userId);
    const lease = await gmailRepository.acquireLease(account.id, 'INITIAL_SYNC_RUNNING', 'INITIAL');
    const counts = emptySyncCounts();
    try {
      const gmail = await createGmailClient(account.id);
      const profile = await this.loadAndValidateProfile(gmail, account.email);
      counts.labelsUpserted = await this.synchronizeLabels(gmail, account.id);
      let pageToken: string | undefined;
      let remaining = env.GMAIL_INITIAL_SYNC_MAX_MESSAGES;
      do {
        await gmailRepository.renewLease(lease);
        const response = await withGmailRetry(() =>
          gmail.users.messages.list({
            userId: 'me',
            maxResults: Math.min(env.GMAIL_SYNC_PAGE_SIZE, remaining),
            ...(pageToken ? { pageToken } : {}),
          }),
        );
        const ids = (response.data.messages ?? [])
          .map((message) => message.id)
          .filter((id): id is string => Boolean(id));
        counts.messagesExamined += ids.length;
        await this.fetchAndPersistMessages(gmail, account.id, ids, counts);
        remaining -= ids.length;
        pageToken = response.data.nextPageToken ?? undefined;
      } while (pageToken && remaining > 0);
      await gmailRepository.complete(lease, counts, profile.historyId ?? null, true);
      return this.result(account.id, counts, profile.historyId ?? null);
    } catch (error) {
      await this.recordFailure(lease, error);
      throw classifyGmailError(error);
    }
  }

  async incrementalSync(userId: string) {
    const account = await gmailRepository.activeAccountForUser(userId);
    const state = await gmailRepository.state(account.id);
    if (!state?.initial_sync_completed_at || !state.last_history_id) {
      throw new AppError(
        'GMAIL_INITIAL_SYNC_REQUIRED',
        'Run the initial Gmail sync before incremental sync.',
        409,
      );
    }
    const lease = await gmailRepository.acquireLease(
      account.id,
      'INCREMENTAL_SYNC_RUNNING',
      'INCREMENTAL',
    );
    const counts = emptySyncCounts();
    try {
      const gmail = await createGmailClient(account.id);
      await this.loadAndValidateProfile(gmail, account.email);
      const changed = new Set<string>();
      const deleted = new Set<string>();
      let pageToken: string | undefined;
      let checkpoint = state.last_history_id;
      do {
        await gmailRepository.renewLease(lease);
        let response;
        try {
          response = await withGmailRetry(() =>
            gmail.users.history.list({
              userId: 'me',
              startHistoryId: state.last_history_id!,
              ...(pageToken ? { pageToken } : {}),
              maxResults: env.GMAIL_SYNC_PAGE_SIZE,
            }),
          );
        } catch (error) {
          if (isHistoryExpired(error)) {
            throw new AppError(
              'GMAIL_HISTORY_EXPIRED',
              'The Gmail history checkpoint expired. Run an initial sync.',
              409,
            );
          }
          throw error;
        }
        for (const history of response.data.history ?? []) {
          this.collectHistory(history, changed, deleted);
        }
        checkpoint = response.data.historyId ?? checkpoint;
        pageToken = response.data.nextPageToken ?? undefined;
      } while (pageToken);

      for (const id of deleted) changed.delete(id);
      const changedIds = [...changed];
      counts.messagesExamined = changedIds.length + deleted.size;
      await this.fetchAndPersistMessages(gmail, account.id, changedIds, counts);
      const deletion = await gmailRepository.markDeleted(account.id, [...deleted]);
      counts.messagesDeleted = deletion.count;
      await gmailRepository.complete(lease, counts, checkpoint, false);
      return this.result(account.id, counts, checkpoint);
    } catch (error) {
      await this.recordFailure(lease, error);
      if (error instanceof AppError) throw error;
      throw classifyGmailError(error);
    }
  }

  async status(userId: string) {
    const account = await gmailRepository.activeAccountForUser(userId);
    const [state, messageCount] = await Promise.all([
      gmailRepository.state(account.id),
      gmailRepository.countMessages(account.id),
    ]);
    return {
      status: state?.status ?? 'NOT_STARTED',
      initialSyncCompleted: Boolean(state?.initial_sync_completed_at),
      lastSuccessfulSyncAt: state?.last_successful_sync_at?.toISOString() ?? null,
      lastErrorCode: state?.last_error_code ?? null,
      nextRetryAt: state?.next_retry_at?.toISOString() ?? null,
      messageCount,
      syncRunning: Boolean(state?.lease_expires_at && state.lease_expires_at > new Date()),
    };
  }

  private async result(accountId: string, counts: SyncCounts, checkpoint: string | null) {
    return {
      success: true,
      ...counts,
      checkpointHistoryId: checkpoint,
      messageCount: await gmailRepository.countMessages(accountId),
    };
  }

  private async loadAndValidateProfile(gmail: GmailClient, expectedEmail: string) {
    const response = await withGmailRetry(() => gmail.users.getProfile({ userId: 'me' }));
    if (
      response.data.emailAddress &&
      response.data.emailAddress.toLowerCase() !== expectedEmail.toLowerCase()
    ) {
      throw new AppError(
        'GMAIL_ACCOUNT_MISMATCH',
        'The Gmail identity does not match the connected account.',
        409,
      );
    }
    return response.data;
  }

  private async listLabels(gmail: GmailClient): Promise<gmail_v1.Schema$Label[]> {
    const response = await withGmailRetry(() => gmail.users.labels.list({ userId: 'me' }));
    return response.data.labels ?? [];
  }

  private async synchronizeLabels(gmail: GmailClient, accountId: string): Promise<number> {
    const labels = await this.listLabels(gmail);
    for (const managed of MANAGED_LABELS) {
      if (!labels.some((label) => label.name === managed.name)) {
        const created = await withGmailRetry(() =>
          gmail.users.labels.create({
            userId: 'me',
            requestBody: {
              name: managed.name,
              labelListVisibility: 'labelShow',
              messageListVisibility: 'show',
            },
          }),
        );
        if (created.data.id) labels.push(created.data);
      }
    }
    const stored = labels
      .filter((label): label is gmail_v1.Schema$Label & { id: string; name: string } =>
        Boolean(label.id && label.name),
      )
      .map((label) => ({
        id: label.id,
        name: label.name,
        type: label.type ?? 'user',
        messageListVisibility: label.messageListVisibility ?? null,
        labelListVisibility: label.labelListVisibility ?? null,
        managedPurpose:
          MANAGED_LABELS.find((managed) => managed.name === label.name)?.purpose ?? null,
      }));
    await gmailRepository.upsertLabels(accountId, stored);
    return stored.length;
  }

  private async fetchAndPersistMessages(
    gmail: GmailClient,
    accountId: string,
    ids: string[],
    counts: SyncCounts,
  ): Promise<void> {
    for (const batch of chunks(ids, env.GMAIL_SYNC_BATCH_SIZE)) {
      const records = await Promise.all(
        batch.map(async (id) => {
          try {
            const response = await withGmailRetry(() =>
              gmail.users.messages.get({
                userId: 'me',
                id,
                format: 'metadata',
                metadataHeaders: METADATA_HEADERS,
              }),
            );
            return mapGmailMessage(response.data);
          } catch (error) {
            if (isHistoryExpired(error)) {
              await gmailRepository.markDeleted(accountId, [id]);
              counts.messagesDeleted += 1;
              return null;
            }
            throw error;
          }
        }),
      );
      const present = records.filter((record) => record !== null);
      await gmailRepository.upsertMessages(accountId, present);
      counts.messagesUpserted += present.length;
    }
  }

  private collectHistory(
    history: gmail_v1.Schema$History,
    changed: Set<string>,
    deleted: Set<string>,
  ): void {
    for (const message of history.messages ?? []) if (message.id) changed.add(message.id);
    for (const entry of history.messagesAdded ?? [])
      if (entry.message?.id) changed.add(entry.message.id);
    for (const entry of history.labelsAdded ?? [])
      if (entry.message?.id) changed.add(entry.message.id);
    for (const entry of history.labelsRemoved ?? [])
      if (entry.message?.id) changed.add(entry.message.id);
    for (const entry of history.messagesDeleted ?? [])
      if (entry.message?.id) deleted.add(entry.message.id);
  }

  private async recordFailure(lease: SyncLease, error: unknown): Promise<void> {
    const classified = error instanceof AppError ? error : classifyGmailError(error);
    if (classified.code === 'GMAIL_REAUTH_REQUIRED') {
      await connectedGoogleAccountRepository.markReauthenticationRequired(
        lease.accountId,
        'GMAIL_API_UNAUTHORIZED',
      );
    }
    await gmailRepository.fail(lease, classified.code);
  }
}

export const gmailSyncService = new GmailSyncService();
