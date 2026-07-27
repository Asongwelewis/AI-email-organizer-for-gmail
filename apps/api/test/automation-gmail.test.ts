import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createGmailClient: vi.fn(),
  findLabel: vi.fn(),
  upsertLabels: vi.fn(),
}));

vi.mock('../src/integrations/gmail/gmail.client.js', () => ({
  createGmailClient: mocks.createGmailClient,
  withGmailRetry: (operation: () => Promise<unknown>) => operation(),
}));
vi.mock('../src/database/prisma.js', () => ({
  prisma: { gmail_labels: { findFirst: mocks.findLabel } },
}));
vi.mock('../src/integrations/gmail/gmail.repository.js', () => ({
  gmailRepository: { upsertLabels: mocks.upsertLabels },
}));

import { AutomationGmailService } from '../src/features/automation/automation-gmail.service.js';

describe('AutomationGmailService', () => {
  beforeEach(() => vi.resetAllMocks());

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
