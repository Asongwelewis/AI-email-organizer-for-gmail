import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createGmailClient: vi.fn(),
  findLabel: vi.fn(),
  upsertLabels: vi.fn(),
  findAccount: vi.fn(),
}));

vi.mock('../src/integrations/gmail/gmail.client.js', () => ({
  createGmailClient: mocks.createGmailClient,
  withGmailRetry: (operation: () => Promise<unknown>) => operation(),
}));
vi.mock('../src/database/prisma.js', () => ({
  prisma: {
    gmail_labels: { findFirst: mocks.findLabel },
    connected_google_accounts: { findUnique: mocks.findAccount },
  },
}));
vi.mock('../src/integrations/gmail/gmail.repository.js', () => ({
  gmailRepository: { upsertLabels: mocks.upsertLabels },
}));

import { AutomationGmailService } from '../src/features/automation/automation-gmail.service.js';

const MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';

describe('AutomationGmailService', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Card 25. Every write here needs the restricted scope, and this suite is about mailboxes
    // that granted it; the refusal when one did not is its own test below.
    mocks.findAccount.mockResolvedValue({ granted_scopes: [MODIFY] });
  });

  /**
   * Card 25. `GMAIL_WRITE_ENABLED` says whether this deployment offers the label export;
   * `gmail.modify` says whether this person granted it. The second cannot be turned on from a
   * config file, and finding it out here beats a 403 from Google four thousand messages into a
   * filing run that has already half-moved the mailbox.
   */
  it('refuses every write on a mailbox connected for reading only', async () => {
    mocks.findAccount.mockResolvedValue({ granted_scopes: [READONLY] });
    mocks.findLabel.mockResolvedValue(null);
    const service = new AutomationGmailService();

    for (const attempt of [
      () => service.ensureLabel('account-1', 'MailMind/Work'),
      () => service.renameLabel('account-1', 'label-1', 'MailMind/Other'),
      () => service.applyLabel('account-1', 'message-1', 'label-1'),
      () => service.applyExclusiveLabel('account-1', 'message-1', 'label-1', []),
    ]) {
      await expect(attempt()).rejects.toMatchObject({
        code: 'GMAIL_WRITE_SCOPE_MISSING',
        statusCode: 403,
      });
    }
    // It refuses before it builds a client, so nothing reached Google at all.
    expect(mocks.createGmailClient).not.toHaveBeenCalled();
  });

  it('creates a missing label once and applies it through messages.modify', async () => {
    const gmail = {
      users: {
        labels: {
          list: vi.fn().mockResolvedValue({ data: { labels: [] } }),
          create: vi.fn().mockResolvedValue({
            data: { id: 'label-1', name: 'MailMind/Work', type: 'user' },
          }),
        },
        messages: { modify: vi.fn().mockResolvedValue({ data: {} }) },
      },
    };
    mocks.findLabel.mockResolvedValue(null);
    mocks.createGmailClient.mockResolvedValue(gmail);
    mocks.upsertLabels.mockResolvedValue(undefined);
    const service = new AutomationGmailService();

    await expect(service.ensureLabel('account-1', 'MailMind/Work')).resolves.toEqual({
      id: 'label-1',
      created: true,
    });
    await service.applyLabel('account-1', 'message-1', 'label-1');

    expect(gmail.users.labels.create).toHaveBeenCalledTimes(1);
    expect(gmail.users.messages.modify).toHaveBeenCalledWith({
      userId: 'me',
      id: 'message-1',
      requestBody: { addLabelIds: ['label-1'] },
    });
  });

  it('reuses a stored Gmail label without a remote create call', async () => {
    mocks.findLabel.mockResolvedValue({ gmail_label_id: 'existing-label' });
    await expect(
      new AutomationGmailService().ensureLabel('account-1', 'MailMind/Work'),
    ).resolves.toEqual({ id: 'existing-label', created: false });
    expect(mocks.createGmailClient).not.toHaveBeenCalled();
  });

  it('discovers and reuses an existing remote Gmail label before creating one', async () => {
    const gmail = {
      users: {
        labels: {
          list: vi.fn().mockResolvedValue({
            data: { labels: [{ id: 'remote-label', name: 'MailMind/Finance', type: 'user' }] },
          }),
          create: vi.fn(),
        },
      },
    };
    mocks.findLabel.mockResolvedValue(null);
    mocks.createGmailClient.mockResolvedValue(gmail);
    mocks.upsertLabels.mockResolvedValue(undefined);

    await expect(
      new AutomationGmailService().ensureLabel('account-1', 'MailMind/Finance'),
    ).resolves.toEqual({ id: 'remote-label', created: false });

    expect(gmail.users.labels.create).not.toHaveBeenCalled();
    expect(mocks.upsertLabels).toHaveBeenCalledTimes(1);
  });
});

/**
 * The invariant the whole facet design rests on: a message carries exactly one MailMind label or
 * none. Its callers are covered with this method mocked out, which left the method itself — the
 * one place the invariant is actually enforced — with no test at all.
 */
describe('the exclusive apply', () => {
  const gmailWithModify = () => {
    const gmail = {
      users: { messages: { modify: vi.fn().mockResolvedValue({ data: {} }) } },
    };
    mocks.createGmailClient.mockResolvedValue(gmail);
    return gmail;
  };

  // One call, not two. Adding first and removing after leaves a window in which the message sits
  // in two folders, and a crash between them makes that window permanent.
  it('adds the new label and removes the others in a single modify', async () => {
    const gmail = gmailWithModify();

    await new AutomationGmailService().applyExclusiveLabel('account-1', 'message-1', 'label-new', [
      'label-old',
      'label-older',
    ]);

    expect(gmail.users.messages.modify).toHaveBeenCalledTimes(1);
    expect(gmail.users.messages.modify).toHaveBeenCalledWith({
      userId: 'me',
      id: 'message-1',
      requestBody: { addLabelIds: ['label-new'], removeLabelIds: ['label-old', 'label-older'] },
    });
  });

  // Re-filing a message into the folder it is already in must not strip the label being applied.
  // Gmail would honour both instructions and the message would come out unfiled.
  it('never removes the label it is adding', async () => {
    const gmail = gmailWithModify();

    await new AutomationGmailService().applyExclusiveLabel('account-1', 'message-1', 'label-keep', [
      'label-keep',
      'label-old',
    ]);

    expect(gmail.users.messages.modify).toHaveBeenCalledWith({
      userId: 'me',
      id: 'message-1',
      requestBody: { addLabelIds: ['label-keep'], removeLabelIds: ['label-old'] },
    });
  });

  it('sends no addLabelIds at all for a message that now fits nowhere', async () => {
    const gmail = gmailWithModify();

    await new AutomationGmailService().applyExclusiveLabel('account-1', 'message-1', null, [
      'label-old',
    ]);

    expect(gmail.users.messages.modify).toHaveBeenCalledWith({
      userId: 'me',
      id: 'message-1',
      requestBody: { removeLabelIds: ['label-old'] },
    });
  });

  // A no-fit message that never had a MailMind label needs nothing done to it. Re-filing a whole
  // mailbox walks every message, so the calls saved here are most of them.
  it('does not reach Gmail when there is nothing to add and nothing to remove', async () => {
    await new AutomationGmailService().applyExclusiveLabel('account-1', 'message-1', null, []);

    expect(mocks.createGmailClient).not.toHaveBeenCalled();
  });

  // A message already in the right folder still costs one modify, which is the price card 09
  // states for re-filing: one Gmail call per message and not a single re-classification. What it
  // must not carry is a removal, or the label would be added and taken away in the same breath.
  it('re-applies without a removal when the message is already in the right folder', async () => {
    const gmail = gmailWithModify();

    await new AutomationGmailService().applyExclusiveLabel('account-1', 'message-1', 'label-keep', [
      'label-keep',
    ]);

    expect(gmail.users.messages.modify).toHaveBeenCalledWith({
      userId: 'me',
      id: 'message-1',
      requestBody: { addLabelIds: ['label-keep'] },
    });
  });
});

/**
 * Renaming is the pivot's answer to a folder whose combination survived a change in how one of
 * its values is spelled. It keeps the label id, and therefore keeps the mail already under it.
 */
describe('renaming a label', () => {
  it('renames in place and records the new name against the same id', async () => {
    const gmail = {
      users: {
        labels: {
          update: vi.fn().mockResolvedValue({
            data: { id: 'label-1', name: 'MailMind/Netflix', type: 'user' },
          }),
        },
      },
    };
    mocks.createGmailClient.mockResolvedValue(gmail);
    mocks.upsertLabels.mockResolvedValue(undefined);

    await new AutomationGmailService().renameLabel('account-1', 'label-1', 'MailMind/Netflix');

    expect(gmail.users.labels.update).toHaveBeenCalledWith({
      userId: 'me',
      id: 'label-1',
      requestBody: { name: 'MailMind/Netflix' },
    });
    // The id never changes, which is the entire point: the mail under it is untouched.
    expect(mocks.upsertLabels).toHaveBeenCalledWith('account-1', [
      expect.objectContaining({ id: 'label-1', name: 'MailMind/Netflix' }),
    ]);
  });

  // Recording a rename that did not happen would leave the database describing a mailbox that
  // disagrees with it, and the next pivot would believe the folder was already renamed.
  it('refuses to record a rename Gmail did not confirm', async () => {
    mocks.createGmailClient.mockResolvedValue({
      users: { labels: { update: vi.fn().mockResolvedValue({ data: {} }) } },
    });

    await expect(
      new AutomationGmailService().renameLabel('account-1', 'label-1', 'MailMind/Netflix'),
    ).rejects.toThrow('GMAIL_LABEL_RENAME_INVALID_RESPONSE');
    expect(mocks.upsertLabels).not.toHaveBeenCalled();
  });
});
