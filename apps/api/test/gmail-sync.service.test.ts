import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createGmailClient: vi.fn(),
  activeAccountForUser: vi.fn(),
  acquireLease: vi.fn(),
  renewLease: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  upsertLabels: vi.fn(),
  upsertMessages: vi.fn(),
  markDeleted: vi.fn(),
  state: vi.fn(),
  countMessages: vi.fn(),
  markReauthenticationRequired: vi.fn(),
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
    complete: mocks.complete,
    fail: mocks.fail,
    upsertLabels: mocks.upsertLabels,
    upsertMessages: mocks.upsertMessages,
    markDeleted: mocks.markDeleted,
    state: mocks.state,
    countMessages: mocks.countMessages,
  },
}));
vi.mock('../src/repositories/connected-google-account.repository.js', () => ({
  connectedGoogleAccountRepository: {
    markReauthenticationRequired: mocks.markReauthenticationRequired,
  },
}));

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
    mocks.complete.mockResolvedValue(undefined);
    mocks.fail.mockResolvedValue(undefined);
    mocks.upsertLabels.mockResolvedValue(undefined);
    mocks.upsertMessages.mockResolvedValue(undefined);
    mocks.markDeleted.mockResolvedValue({ count: 0 });
    mocks.countMessages.mockResolvedValue(1);
  });

  it('performs a bounded metadata-only initial sync and commits the profile checkpoint', async () => {
    const gmail = {
      users: {
        getProfile: vi.fn().mockResolvedValue({
          data: { emailAddress: account.email, historyId: 'history-2' },
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
          list: vi.fn().mockResolvedValue({
            data: { messages: [{ id: 'message-1' }] },
          }),
          get: vi.fn().mockResolvedValue({
            data: {
              id: 'message-1',
              threadId: 'thread-1',
              historyId: 'history-1',
              labelIds: ['INBOX'],
              payload: { headers: [{ name: 'Subject', value: 'Metadata only' }] },
            },
          }),
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
        expect.objectContaining({ gmail_message_id: 'message-1', subject: 'Metadata only' }),
      ]),
    );
    expect(mocks.complete).toHaveBeenCalledWith(
      lease,
      expect.objectContaining({ messagesUpserted: 1, labelsUpserted: 3 }),
      'history-2',
      true,
    );
    expect(result).toMatchObject({ success: true, checkpointHistoryId: 'history-2' });
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
});
