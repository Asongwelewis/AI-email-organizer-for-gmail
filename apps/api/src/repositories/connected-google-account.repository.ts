import type { google_connection_status, Prisma } from '@prisma/client';

import { prisma } from '@api/database/prisma.js';

export class ConnectedGoogleAccountRepository {
  findForUser(userId: string) {
    return prisma.connected_google_accounts.findFirst({
      where: { user_id: userId },
      orderBy: [{ gmail_connected: 'desc' }, { updated_at: 'desc' }],
    });
  }

  findById(id: string) {
    return prisma.connected_google_accounts.findUnique({ where: { id } });
  }

  findByUserAndSubject(userId: string, googleSubject: string) {
    return prisma.connected_google_accounts.findUnique({
      where: {
        user_id_google_subject: { user_id: userId, google_subject: googleSubject },
      },
    });
  }

  upsert(
    userId: string,
    googleSubject: string,
    data: Omit<Prisma.connected_google_accountsUncheckedCreateInput, 'user_id' | 'google_subject'>,
  ) {
    return prisma.connected_google_accounts.upsert({
      where: { user_id_google_subject: { user_id: userId, google_subject: googleSubject } },
      create: { ...data, user_id: userId, google_subject: googleSubject },
      update: data,
    });
  }

  replaceActiveForUser(
    userId: string,
    googleSubject: string,
    data: Omit<Prisma.connected_google_accountsUncheckedCreateInput, 'user_id' | 'google_subject'>,
  ) {
    return prisma.$transaction(async (transaction) => {
      // Serialize identity replacement per MailMind user across API instances.
      // This prevents two separately valid OAuth states from leaving two active accounts.
      await transaction.$queryRaw`
        select true as acquired
        from pg_advisory_xact_lock(hashtextextended(${userId}, 0))
      `;
      await transaction.connected_google_accounts.updateMany({
        where: { user_id: userId, google_subject: { not: googleSubject } },
        data: {
          access_token_ciphertext: null,
          access_token_iv: null,
          access_token_auth_tag: null,
          refresh_token_ciphertext: null,
          refresh_token_iv: null,
          refresh_token_auth_tag: null,
          encryption_key_version: null,
          access_token_expires_at: null,
          gmail_connected: false,
          connection_status: 'DISCONNECTED',
          disconnected_at: new Date(),
        },
      });
      return transaction.connected_google_accounts.upsert({
        where: { user_id_google_subject: { user_id: userId, google_subject: googleSubject } },
        create: { ...data, user_id: userId, google_subject: googleSubject },
        update: data,
      });
    });
  }

  update(id: string, data: Prisma.connected_google_accountsUpdateInput) {
    return prisma.connected_google_accounts.update({ where: { id }, data });
  }

  conditionalTokenUpdate(
    id: string,
    previousExpiry: Date | null,
    data: Prisma.connected_google_accountsUpdateManyMutationInput,
  ) {
    return prisma.connected_google_accounts.updateMany({
      where: { id, access_token_expires_at: previousExpiry },
      data,
    });
  }

  markReauthenticationRequired(id: string, errorCode: string) {
    return this.update(id, {
      connection_status: 'REAUTH_REQUIRED',
      gmail_connected: false,
      last_connection_error_code: errorCode,
      last_connection_error_at: new Date(),
      access_token_ciphertext: null,
      access_token_iv: null,
      access_token_auth_tag: null,
      access_token_expires_at: null,
    });
  }

  setStatus(id: string, status: google_connection_status) {
    return this.update(id, { connection_status: status });
  }
}

export const connectedGoogleAccountRepository = new ConnectedGoogleAccountRepository();
