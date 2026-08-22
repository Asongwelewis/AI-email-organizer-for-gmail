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

  async renameLabel(accountId: string, labelId: string, labelPath: string): Promise<void> {
    const gmail = await createGmailClient(accountId);
    const updated = await withGmailRetry(() =>
      gmail.users.labels.update({
        userId: 'me',
        id: labelId,
        requestBody: { name: labelPath },
      }),
    );
    if (!updated.data.id || !updated.data.name) {
      throw new Error('GMAIL_LABEL_RENAME_INVALID_RESPONSE');
    }
    await gmailRepository.upsertLabels(accountId, [
      {
        id: updated.data.id,
        name: updated.data.name,
        type: updated.data.type ?? 'user',
        messageListVisibility: updated.data.messageListVisibility ?? null,
        labelListVisibility: updated.data.labelListVisibility ?? null,
        managedPurpose: 'AUTOMATION',
      },
    ]);
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

  /**
   * Applies one MailMind label and removes every other one in the same call.
   *
   * A message carries exactly one MailMind label or none, and re-filing a mailbox breaks that the
   * moment a message's folder changes: adding the new label without removing the old leaves the
   * message in two folders at once. One `modify` does both, so there is no window in which the
   * message wears neither label or both.
   *
   * Pass `labelId` as null to remove MailMind's labels and add nothing — the NONE decision, for a
   * message that was filed under the old tree and belongs nowhere under the new one.
   */
  async applyExclusiveLabel(
    accountId: string,
    remoteMessageId: string,
    labelId: string | null,
    otherMailMindLabelIds: string[],
  ): Promise<void> {
    const removeLabelIds = otherMailMindLabelIds.filter((id) => id !== labelId);
    if (!labelId && removeLabelIds.length === 0) return;
    const gmail = await createGmailClient(accountId);
    await withGmailRetry(() =>
      gmail.users.messages.modify({
        userId: 'me',
        id: remoteMessageId,
        requestBody: {
          ...(labelId ? { addLabelIds: [labelId] } : {}),
          ...(removeLabelIds.length > 0 ? { removeLabelIds } : {}),
        },
      }),
    );
  }
}

export const automationGmailService = new AutomationGmailService();
