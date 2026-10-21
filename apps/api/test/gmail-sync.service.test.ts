import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createGmailClient: vi.fn(),
  activeAccountForUser: vi.fn(),
  acquireLease: vi.fn(),
  renewLease: vi.fn(),
  beginBackfill: vi.fn(),
  checkpointBackfillPage: vi.fn(),
  updateMailboxTotal: vi.fn(),
  markMissingFromBackfill: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  upsertLabels: vi.fn(),
  upsertMessages: vi.fn(),
  markDeleted: vi.fn(),
  state: vi.fn(),
  countMessages: vi.fn(),
  coverage: vi.fn(),
  markReauthenticationRequired: vi.fn(),
  findById: vi.fn(),
  refreshGoogleAccessToken: vi.fn(),
}));

vi.mock('../src/integrations/gmail/gmail.client.js', () => ({
  createGmailClient: mocks.createGmailClient,
  withGmailRetry: (operation: () => Promise<unknown>) => operation(),
}));
vi.mock('../src/integrations/gmail/gmail.repository.js', () => ({
  gmailRepository: {
    activeAccountForUser: mocks.activeAccountForUser,
    acquireLease: mocks.acquireLease,
    renewLease: mocks.renewLease,
    beginBackfill: mocks.beginBackfill,
    checkpointBackfillPage: mocks.checkpointBackfillPage,
    updateMailboxTotal: mocks.updateMailboxTotal,
    markMissingFromBackfill: mocks.markMissingFromBackfill,
    complete: mocks.complete,
    fail: mocks.fail,
    upsertLabels: mocks.upsertLabels,
    upsertMessages: mocks.upsertMessages,
    markDeleted: mocks.markDeleted,
    state: mocks.state,
    countMessages: mocks.countMessages,
    coverage: mocks.coverage,
  },
}));
vi.mock('../src/repositories/connected-google-account.repository.js', () => ({
  connectedGoogleAccountRepository: {
    markReauthenticationRequired: mocks.markReauthenticationRequired,
    findById: mocks.findById,
  },
}));
vi.mock('../src/integrations/google/google-token.service.js', () => ({
  googleTokenService: { refreshGoogleAccessToken: mocks.refreshGoogleAccessToken },
}));

import { env } from '../src/config/env.js';
import { GmailSyncService } from '../src/integrations/gmail/gmail.service.js';

const account = {
  id: 'account-id',
  user_id: 'user-id',
  email: 'owner@gmail.com',
};
const lease = { accountId: account.id, token: 'lease-token', runId: 'run-id' };

describe('GmailSyncService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.activeAccountForUser.mockResolvedValue(account);
    mocks.acquireLease.mockResolvedValue(lease);
    mocks.renewLease.mockResolvedValue(undefined);
    mocks.beginBackfill.mockResolvedValue({
      backfill_page_token: null,
      backfill_history_id: 'history-2',
      backfill_started_at: new Date('2026-07-26T00:00:00.000Z'),
    });
    mocks.checkpointBackfillPage.mockResolvedValue(undefined);
    mocks.updateMailboxTotal.mockResolvedValue(undefined);
    mocks.markMissingFromBackfill.mockResolvedValue({ count: 0 });
    mocks.complete.mockResolvedValue(undefined);
    mocks.fail.mockResolvedValue(undefined);
    mocks.upsertLabels.mockResolvedValue(undefined);
    mocks.upsertMessages.mockResolvedValue(undefined);
    mocks.markDeleted.mockResolvedValue({ count: 0 });
    mocks.countMessages.mockResolvedValue(1);
    mocks.coverage.mockResolvedValue({
      syncedMessages: 2,
      classifiedMessages: 1,
      unprocessedMessages: 1,
    });
  });

  it('backfills every Gmail page and checkpoints each page before completing', async () => {
    const gmail = {
      users: {
        getProfile: vi.fn().mockResolvedValue({
          data: { emailAddress: account.email, historyId: 'history-2', messagesTotal: 2 },
        }),
        labels: {
          list: vi.fn().mockResolvedValue({ data: { labels: [] } }),
          create: vi.fn().mockImplementation(({ requestBody }) =>
            Promise.resolve({
              data: { id: `id-${requestBody.name}`, name: requestBody.name, type: 'user' },
            }),
          ),
        },
        messages: {
          list: vi
            .fn()
            .mockResolvedValueOnce({
              data: { messages: [{ id: 'message-1' }], nextPageToken: 'page-2' },
            })
            .mockResolvedValueOnce({ data: { messages: [{ id: 'message-2' }] } }),
          get: vi.fn().mockImplementation(({ id }) =>
            Promise.resolve({
              data: {
                id,
                threadId: `thread-${id}`,
                historyId: 'history-1',
                labelIds: ['INBOX'],
                payload: { headers: [{ name: 'Subject', value: `Metadata ${id}` }] },
              },
            }),
          ),
        },
        history: { list: vi.fn() },
      },
    };
    mocks.createGmailClient.mockResolvedValue(gmail);

    const result = await new GmailSyncService().initialSync('user-id');

    expect(gmail.users.messages.get).toHaveBeenCalledWith(
      expect.objectContaining({
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'To', 'Cc', 'Date'],
      }),
    );
    expect(mocks.upsertMessages).toHaveBeenCalledWith(
      account.id,
      expect.arrayContaining([
        expect.objectContaining({
          gmail_message_id: 'message-1',
          subject: 'Metadata message-1',
        }),
      ]),
    );
    expect(mocks.complete).toHaveBeenCalledWith(
      lease,
      // The parent label is not created: reading a mailbox never writes to it.
      expect.objectContaining({ messagesUpserted: 2, labelsUpserted: 0 }),
      'history-2',
      true,
    );
    expect(mocks.checkpointBackfillPage).toHaveBeenNthCalledWith(1, lease, 'page-2', 1);
    expect(mocks.checkpointBackfillPage).toHaveBeenNthCalledWith(2, lease, null, 1);
    expect(gmail.users.messages.list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pageToken: 'page-2' }),
    );
    expect(result).toMatchObject({ success: true, checkpointHistoryId: 'history-2' });
  });

  it('resumes a historical backfill from the durable page checkpoint', async () => {
    mocks.beginBackfill.mockResolvedValue({
      backfill_page_token: 'resume-token',
      backfill_history_id: 'original-history',
      backfill_started_at: new Date('2026-07-26T00:00:00.000Z'),
    });
    const gmail = {
      users: {
        getProfile: vi.fn().mockResolvedValue({
          data: {
            emailAddress: account.email,
            historyId: 'newer-history',
            messagesTotal: 500,
          },
        }),
        labels: {
          list: vi.fn().mockResolvedValue({
            data: {
              labels: [
                { id: 'root', name: 'MailMind' },
                { id: 'processed', name: 'MailMind/Processed' },
                { id: 'review', name: 'MailMind/Needs Review' },
              ],
            },
          }),
          create: vi.fn(),
        },
        messages: {
          list: vi.fn().mockResolvedValue({ data: { messages: [] } }),
          get: vi.fn(),
        },
      },
    };
    mocks.createGmailClient.mockResolvedValue(gmail);

    await new GmailSyncService().initialSync('user-id');

    expect(gmail.users.messages.list).toHaveBeenCalledWith(
      expect.objectContaining({ pageToken: 'resume-token' }),
    );
    expect(mocks.complete).toHaveBeenCalledWith(
      lease,
      expect.any(Object),
      'original-history',
      true,
    );
  });

  it('preserves the checkpoint and records history expiry for a fresh initial sync', async () => {
    mocks.state.mockResolvedValue({
      initial_sync_completed_at: new Date(),
      last_history_id: 'expired-history',
    });
    mocks.createGmailClient.mockResolvedValue({
      users: {
        getProfile: vi.fn().mockResolvedValue({
          data: { emailAddress: account.email, historyId: 'new-history' },
        }),
        history: {
          list: vi.fn().mockRejectedValue({ response: { status: 404 } }),
        },
      },
    });

    await expect(new GmailSyncService().incrementalSync('user-id')).rejects.toMatchObject({
      code: 'GMAIL_HISTORY_EXPIRED',
    });
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.fail).toHaveBeenCalledWith(lease, 'GMAIL_HISTORY_EXPIRED');
  });

  it('keeps incremental history sync for messages arriving after the backfill baseline', async () => {
    mocks.state.mockResolvedValue({
      initial_sync_completed_at: new Date(),
      last_history_id: 'baseline-history',
    });
    const gmail = {
      users: {
        getProfile: vi.fn().mockResolvedValue({
          data: { emailAddress: account.email, historyId: 'history-3', messagesTotal: 3 },
        }),
        history: {
          list: vi.fn().mockResolvedValue({
            data: {
              historyId: 'history-3',
              history: [{ messagesAdded: [{ message: { id: 'new-message' } }] }],
            },
          }),
        },
        messages: {
          get: vi.fn().mockResolvedValue({
            data: {
              id: 'new-message',
              historyId: 'history-3',
              labelIds: ['INBOX'],
              payload: { headers: [{ name: 'Subject', value: 'Arrived during backfill' }] },
            },
          }),
        },
      },
    };
    mocks.createGmailClient.mockResolvedValue(gmail);

    const result = await new GmailSyncService().incrementalSync('user-id');

    expect(mocks.updateMailboxTotal).toHaveBeenCalledWith(lease, 3);
    expect(mocks.upsertMessages).toHaveBeenCalledWith(
      account.id,
      expect.arrayContaining([
        expect.objectContaining({
          gmail_message_id: 'new-message',
          subject: 'Arrived during backfill',
        }),
      ]),
    );
    expect(mocks.complete).toHaveBeenCalledWith(
      lease,
      expect.objectContaining({ messagesExamined: 1, messagesUpserted: 1 }),
      'history-3',
      false,
    );
    expect(result.checkpointHistoryId).toBe('history-3');
  });

  it('reports Gmail, sync, classification, unprocessed, and backfill checkpoint counts separately', async () => {
    const checkpointedAt = new Date('2026-07-26T12:00:00.000Z');
    mocks.state.mockResolvedValue({
      status: 'INITIAL_SYNC_RUNNING',
      initial_sync_completed_at: null,
      last_successful_sync_at: null,
      last_error_code: null,
      next_retry_at: null,
      lease_expires_at: new Date(Date.now() + 60_000),
      total_gmail_messages: 500,
      backfill_started_at: new Date(),
      backfill_completed_at: null,
      backfill_messages_processed: 200,
      backfill_pages_completed: 2,
      backfill_checkpointed_at: checkpointedAt,
      backfill_history_id: 'baseline-history',
    });

    const result = await new GmailSyncService().status('user-id');

    expect(result).toMatchObject({
      totalGmailMessages: 500,
      syncedMessages: 2,
      classifiedMessages: 1,
      unprocessedMessages: 1,
      backfill: {
        running: true,
        messagesProcessed: 200,
        remainingMessages: 300,
        pagesCompleted: 2,
        checkpointedAt: checkpointedAt.toISOString(),
        checkpointHistoryId: 'baseline-history',
      },
    });
  });

  it('keeps the account connected when a mid-run 401 is only an expired access token', async () => {
    // A backfill outlives the hour a Google access token lasts, so the 401 it takes at the end
    // says nothing about the grant. Disconnecting on the response alone stranded a valid account.
    const unauthorized = Object.assign(new Error('Invalid Credentials'), {
      response: { status: 401 },
    });
    mocks.createGmailClient.mockResolvedValue({
      users: { getProfile: vi.fn().mockRejectedValue(unauthorized) },
    });
    mocks.findById.mockResolvedValue({ id: account.id, user_id: account.user_id });
    mocks.refreshGoogleAccessToken.mockResolvedValue('a-fresh-access-token');

    await expect(new GmailSyncService().initialSync('user-id')).rejects.toMatchObject({
      code: 'GMAIL_REAUTH_REQUIRED',
    });

    expect(mocks.refreshGoogleAccessToken).toHaveBeenCalledTimes(1);
    expect(mocks.markReauthenticationRequired).not.toHaveBeenCalled();
    expect(mocks.fail).toHaveBeenCalledWith(lease, 'GMAIL_REAUTH_REQUIRED');
  });

  it('leaves a genuinely revoked grant to be marked by the refresh that rejected it', async () => {
    const unauthorized = Object.assign(new Error('Invalid Credentials'), {
      response: { status: 401 },
    });
    mocks.createGmailClient.mockResolvedValue({
      users: { getProfile: vi.fn().mockRejectedValue(unauthorized) },
    });
    mocks.findById.mockResolvedValue({ id: account.id, user_id: account.user_id });
    mocks.refreshGoogleAccessToken.mockRejectedValue(new Error('invalid_grant'));

    await expect(new GmailSyncService().initialSync('user-id')).rejects.toMatchObject({
      code: 'GMAIL_REAUTH_REQUIRED',
    });

    expect(mocks.refreshGoogleAccessToken).toHaveBeenCalledTimes(1);
    expect(mocks.fail).toHaveBeenCalledWith(lease, 'GMAIL_REAUTH_REQUIRED');
  });

  it('rejects a profile returned for a different Google identity', async () => {
    mocks.createGmailClient.mockResolvedValue({
      users: {
        getProfile: vi.fn().mockResolvedValue({
          data: { emailAddress: 'other@gmail.com', historyId: 'history' },
        }),
      },
    });
    await expect(new GmailSyncService().profile('user-id')).rejects.toMatchObject({
      code: 'GMAIL_ACCOUNT_MISMATCH',
    });
  });

  /*
   * The watcher asks this every minute. A real incremental sync takes a lease and writes a run
   * row, so the cheap question has to answer "no" without either when nothing has moved.
   */
  describe('the once-a-minute "anything new?" question', () => {
    const profileClient = (historyId: string | null | undefined) => ({
      users: { getProfile: vi.fn().mockResolvedValue({ data: { historyId } }) },
    });

    it('says no when the mailbox history has not moved, without taking a lease', async () => {
      mocks.state.mockResolvedValue({
        initial_sync_completed_at: new Date(),
        last_history_id: '1000',
      });
      mocks.createGmailClient.mockResolvedValue(profileClient('1000'));

      await expect(new GmailSyncService().hasNewHistory('user-id')).resolves.toBe(false);
      expect(mocks.acquireLease).not.toHaveBeenCalled();
    });

    it('says yes once the history id has moved past the checkpoint', async () => {
      mocks.state.mockResolvedValue({
        initial_sync_completed_at: new Date(),
        last_history_id: '999',
      });
      mocks.createGmailClient.mockResolvedValue(profileClient('1000'));

      await expect(new GmailSyncService().hasNewHistory('user-id')).resolves.toBe(true);
    });

    it('compares history ids as numbers, not as text', async () => {
      // As strings, "999" sorts after "1000", which would hide every message from here on.
      mocks.state.mockResolvedValue({
        initial_sync_completed_at: new Date(),
        last_history_id: '999',
      });
      mocks.createGmailClient.mockResolvedValue(profileClient('1000'));
      await expect(new GmailSyncService().hasNewHistory('user-id')).resolves.toBe(true);
    });

    it('says no before the first sync has finished, and never asks Gmail', async () => {
      mocks.state.mockResolvedValue({ initial_sync_completed_at: null, last_history_id: null });

      await expect(new GmailSyncService().hasNewHistory('user-id')).resolves.toBe(false);
      expect(mocks.createGmailClient).not.toHaveBeenCalled();
    });
  });
  /*
   * A first sync used to read the whole mailbox. For one owner with 9,550 messages that was fine;
   * for several hundred people it is the free database's 500 MB several times over.
   */
  /*
   * Every account connected since the read-only downgrade holds `gmail.readonly`, and creating a
   * label with it is a 403. The first sync used to create one regardless, so it failed — and with it
   * every new person's setup — before reading a single message (Sentry JAVASCRIPT-REACT-E).
   */
  describe('the MailMind parent label', () => {
    function gmailWithoutParent() {
      const gmail = {
        users: {
          getProfile: vi.fn().mockResolvedValue({
            data: { emailAddress: account.email, historyId: 'history-2', messagesTotal: 0 },
          }),
          labels: {
            list: vi.fn().mockResolvedValue({ data: { labels: [{ id: 'INBOX', name: 'INBOX' }] } }),
            create: vi
              .fn()
              .mockResolvedValue({ data: { id: 'Label_9', name: 'MailMind', type: 'user' } }),
          },
          messages: { list: vi.fn().mockResolvedValue({ data: {} }), get: vi.fn() },
          history: { list: vi.fn() },
        },
      };
      mocks.createGmailClient.mockResolvedValue(gmail);
      return gmail;
    }

    afterEach(() => {
      env.GMAIL_WRITE_ENABLED = false;
    });

    it('is never created by a sync of a read-only mailbox', async () => {
      env.GMAIL_WRITE_ENABLED = true;
      mocks.activeAccountForUser.mockResolvedValue({
        ...account,
        granted_scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      });
      const gmail = gmailWithoutParent();

      await new GmailSyncService().initialSync('user-id');

      expect(gmail.users.labels.create).not.toHaveBeenCalled();
      expect(mocks.complete).toHaveBeenCalled();
      expect(mocks.fail).not.toHaveBeenCalled();
    });

    it('is not created while the export is switched off, whatever was granted', async () => {
      mocks.activeAccountForUser.mockResolvedValue({
        ...account,
        granted_scopes: ['https://www.googleapis.com/auth/gmail.modify'],
      });
      const gmail = gmailWithoutParent();

      await new GmailSyncService().initialSync('user-id');

      expect(gmail.users.labels.create).not.toHaveBeenCalled();
    });

    it('is created when the export is on and the mailbox granted writing', async () => {
      env.GMAIL_WRITE_ENABLED = true;
      mocks.activeAccountForUser.mockResolvedValue({
        ...account,
        granted_scopes: ['https://www.googleapis.com/auth/gmail.modify'],
      });
      const gmail = gmailWithoutParent();

      await new GmailSyncService().initialSync('user-id');

      expect(gmail.users.labels.create).toHaveBeenCalledWith(
        expect.objectContaining({ requestBody: expect.objectContaining({ name: 'MailMind' }) }),
      );
    });
  });

  describe('a bounded first sync', () => {
    const started = new Date('2026-10-20T00:00:00.000Z');

    function gmailWith(pages: Array<{ ids: string[]; next?: string }>) {
      const list = vi.fn();
      for (const page of pages) {
        list.mockResolvedValueOnce({
          data: {
            messages: page.ids.map((id) => ({ id })),
            ...(page.next ? { nextPageToken: page.next } : {}),
          },
        });
      }
      const gmail = {
        users: {
          getProfile: vi.fn().mockResolvedValue({
            data: { emailAddress: account.email, historyId: 'history-2', messagesTotal: 9550 },
          }),
          labels: {
            list: vi.fn().mockResolvedValue({ data: { labels: [{ id: 'L', name: 'MailMind' }] } }),
            create: vi.fn(),
          },
          messages: {
            list,
            get: vi
              .fn()
              .mockImplementation(({ id }) =>
                Promise.resolve({ data: { id, labelIds: ['INBOX'], payload: { headers: [] } } }),
              ),
          },
          history: { list: vi.fn() },
        },
      };
      mocks.createGmailClient.mockResolvedValue(gmail);
      return gmail;
    }

    beforeEach(() => {
      env.GMAIL_INITIAL_SYNC_LOOKBACK_DAYS = 90;
      env.GMAIL_INITIAL_SYNC_MAX_MESSAGES = 2000;
      mocks.beginBackfill.mockResolvedValue({
        backfill_page_token: null,
        backfill_history_id: 'history-2',
        backfill_started_at: started,
        backfill_messages_processed: 0,
      });
    });

    it('asks Gmail for the recent window only, without spam or trash', async () => {
      const gmail = gmailWith([{ ids: ['a', 'b'] }]);

      await new GmailSyncService().initialSync('user-id');

      const since = new Date(started.getTime() - 90 * 86_400_000);
      expect(gmail.users.messages.list).toHaveBeenCalledWith(
        expect.objectContaining({
          q: `after:${Math.floor(since.getTime() / 1000)}`,
          includeSpamTrash: false,
        }),
      );
      // Only what the window could have listed can be missing from it: older mail an earlier,
      // wider sync stored is left alone.
      expect(mocks.markMissingFromBackfill).toHaveBeenCalledWith(account.id, started, since);
    });

    it('stops at the ceiling, newest first, and marks nothing missing from a partial listing', async () => {
      env.GMAIL_INITIAL_SYNC_MAX_MESSAGES = 2;
      const gmail = gmailWith([
        { ids: ['a', 'b'], next: 'page-2' },
        { ids: ['c'], next: 'page-3' },
      ]);

      const result = await new GmailSyncService().initialSync('user-id');

      expect(gmail.users.messages.list).toHaveBeenCalledTimes(1);
      expect(gmail.users.messages.list).toHaveBeenCalledWith(
        expect.objectContaining({ maxResults: 2 }),
      );
      // Checkpointed as finished, so a resumed backfill does not walk on past the ceiling.
      expect(mocks.checkpointBackfillPage).toHaveBeenCalledWith(lease, null, 2);
      expect(mocks.markMissingFromBackfill).not.toHaveBeenCalled();
      expect(result.messagesUpserted).toBe(2);
    });

    it('reads the whole mailbox, as it used to, when both bounds are zero', async () => {
      env.GMAIL_INITIAL_SYNC_LOOKBACK_DAYS = 0;
      env.GMAIL_INITIAL_SYNC_MAX_MESSAGES = 0;
      const gmail = gmailWith([{ ids: ['a'] }]);

      await new GmailSyncService().initialSync('user-id');

      const request = gmail.users.messages.list.mock.calls[0]![0] as Record<string, unknown>;
      expect(request['includeSpamTrash']).toBe(true);
      expect(request).not.toHaveProperty('q');
      expect(mocks.markMissingFromBackfill).toHaveBeenCalledWith(account.id, started, null);
    });
  });
});
