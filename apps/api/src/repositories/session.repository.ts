import type { Prisma } from '@prisma/client';

import { prisma } from '@api/database/prisma.js';

export class SessionRepository {
  create(data: Prisma.sessionsUncheckedCreateInput) {
    return prisma.sessions.create({ data, include: { users: true } });
  }

  findByTokenHash(sessionTokenHash: string) {
    return prisma.sessions.findUnique({
      where: { session_token_hash: sessionTokenHash },
      include: { users: true },
    });
  }

  touch(id: string, olderThan: Date, now: Date) {
    return prisma.sessions.updateMany({
      where: { id, revoked_at: null, last_used_at: { lt: olderThan } },
      data: { last_used_at: now },
    });
  }

  revoke(id: string, reason: string, now = new Date()) {
    return prisma.sessions.updateMany({
      where: { id, revoked_at: null },
      data: { revoked_at: now, revocation_reason: reason },
    });
  }

  revokeAllForUser(userId: string, reason: string, now = new Date()) {
    return prisma.sessions.updateMany({
      where: { user_id: userId, revoked_at: null },
      data: { revoked_at: now, revocation_reason: reason },
    });
  }

  async rotate(id: string, tokenHash: string, expiresAt: Date) {
    return prisma.$transaction(async (transaction) => {
      const revoked = await transaction.sessions.updateMany({
        where: { id, revoked_at: null, expires_at: { gt: new Date() } },
        data: { revoked_at: new Date(), revocation_reason: 'ROTATED' },
      });
      if (revoked.count !== 1) return null;
      const previous = await transaction.sessions.findUniqueOrThrow({ where: { id } });
      return transaction.sessions.create({
        data: {
          user_id: previous.user_id,
          session_token_hash: tokenHash,
          user_agent: previous.user_agent,
          ip_hash: previous.ip_hash,
          expires_at: expiresAt,
        },
        include: { users: true },
      });
    });
  }
}

export const sessionRepository = new SessionRepository();
