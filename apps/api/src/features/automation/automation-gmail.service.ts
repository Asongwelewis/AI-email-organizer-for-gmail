import { createGmailClient, withGmailRetry } from '@api/integrations/gmail/gmail.client.js';
import { gmailRepository } from '@api/integrations/gmail/gmail.repository.js';
import { prisma } from '@api/database/prisma.js';
import { AppError } from '@api/errors/AppError.js';
import { hasGmailWriteScope } from '@api/integrations/google/google-scopes.js';

/**
 * Every write MailMind makes to a mailbox goes through this class, which is what makes it the one
 * place the authority to make them has to be checked.
 *
 * `GMAIL_WRITE_ENABLED` says whether this deployment offers the label export at all;
 * `gmail.modify` says whether this particular person granted it. Both have to be true, and the
 * second is the one that cannot be turned on from a config file — an account connected under the
 * read-only scope simply cannot be written to, and finding that out here beats finding it out as a
 * 403 from Google half way through nine thousand messages.
 */
export class AutomationGmailService {
  /**
   * Refuses before the first remote write when the account never granted write authority.
   *
   * Reading `granted_scopes` rather than trying the call is deliberate: a partial filing run that
   * dies on message 4,000 leaves a mailbox half in the old tree and half in the new one.
   */
  private async assertWritable(accountId: string): Promise<void> {
    const account = await prisma.connected_google_accounts.findUnique({
      where: { id: accountId },
      select: { granted_scopes: true },
    });
    if (!account || !hasGmailWriteScope(account.granted_scopes)) {
      throw new AppError(
        'GMAIL_WRITE_SCOPE_MISSING',
        'This mailbox was connected for reading only.',
        403,
      );
    }
  }

  async ensureLabel(accountId: string, labelPath: string) {
    const existing = await prisma.gmail_labels.findFirst({
      where: { connected_google_account_id: accountId, name: labelPath },
    });
    if (existing) return { id: existing.gmail_label_id, created: false };

    await this.assertWritable(accountId);
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
    await this.assertWritable(accountId);
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
    await this.assertWritable(accountId);
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
    await this.assertWritable(accountId);
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
