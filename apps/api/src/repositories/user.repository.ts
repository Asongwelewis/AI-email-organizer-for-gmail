import { prisma } from '@api/database/prisma.js';
import { AppError } from '@api/errors/AppError.js';
import type { Prisma } from '@prisma/client';

export interface GoogleIdentityInput {
  googleSubject: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  emailVerified: boolean;
}

export class UserRepository {
  async upsertGoogleIdentityAndCreateSession(
    input: GoogleIdentityInput,
    session: Omit<Prisma.sessionsUncheckedCreateInput, 'user_id'>,
  ) {
    return prisma.$transaction(async (transaction) => {
      const now = new Date();
      const user = await transaction.users.upsert({
        where: { google_subject: input.googleSubject },
        create: {
          google_subject: input.googleSubject,
          email: input.email,
          normalized_email: input.email.trim().toLowerCase(),
          email_verified: input.emailVerified,
          display_name: input.displayName,
          avatar_url: input.avatarUrl,
          last_login_at: now,
        },
        update: {
          email: input.email,
          normalized_email: input.email.trim().toLowerCase(),
          email_verified: input.emailVerified,
          display_name: input.displayName,
          avatar_url: input.avatarUrl,
          last_login_at: now,
        },
      });
      if (user.status === 'SUSPENDED') {
        throw new AppError('AUTH_USER_SUSPENDED', 'This account is suspended.', 403);
      }
      if (user.status === 'DELETED') {
        throw new AppError('AUTH_USER_DELETED', 'This account is unavailable.', 403);
      }
      const createdSession = await transaction.sessions.create({
        data: { ...session, user_id: user.id },
      });
      return { user, session: createdSession };
    });
  }
}

export const userRepository = new UserRepository();
