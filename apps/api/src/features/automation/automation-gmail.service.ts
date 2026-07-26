import { createGmailClient, withGmailRetry } from '@api/integrations/gmail/gmail.client.js';
import { gmailRepository } from '@api/integrations/gmail/gmail.repository.js';
import { prisma } from '@api/database/prisma.js';

export class AutomationGmailService {
  async ensureLabel(accountId: string, labelPath: string) {
    const existing = await prisma.gmail_labels.findFirst({
      where: { connected_google_account_id: accountId, name: labelPath },
    });
    if (existing) return { id: existing.gmail_label_id, created: false };

    const gmail = await createGmailClient(accountId);
    const remote = await withGmailRetry(() => gmail.users.labels.list({ userId: 'me' }));
    let label = remote.data.labels?.find((candidate) => candidate.name === labelPath);
    if (!label?.id) {
      const created = await withGmailRetry(() =>
        gmail.users.labels.create({
          userId: 'me',
          requestBody: {
            name: labelPath,
            labelListVisibility: 'labelShow',
            messageListVisibility: 'show',
          },
        }),
      );
      label = created.data;
    }
    if (!label.id || !label.name) throw new Error('GMAIL_LABEL_CREATE_INVALID_RESPONSE');
    await gmailRepository.upsertLabels(accountId, [
      {
        id: label.id,
        name: label.name,
        type: label.type ?? 'user',
        messageListVisibility: label.messageListVisibility ?? null,
        labelListVisibility: label.labelListVisibility ?? null,
        managedPurpose: 'AUTOMATION',
      },
    ]);
    return { id: label.id, created: !remote.data.labels?.some((item) => item.id === label?.id) };
  }

  async applyLabel(accountId: string, remoteMessageId: string, labelId: string): Promise<void> {
    const gmail = await createGmailClient(accountId);
    await withGmailRetry(() =>
      gmail.users.messages.modify({
        userId: 'me',
        id: remoteMessageId,
        requestBody: { addLabelIds: [labelId] },
      }),
    );
  }
}

export const automationGmailService = new AutomationGmailService();
