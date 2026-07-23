import type { oauth_purpose, Prisma } from '@prisma/client';

import { prisma } from '@api/database/prisma.js';
import { AppError } from '@api/errors/AppError.js';

export class OAuthStateRepository {
  create(data: Prisma.oauth_statesUncheckedCreateInput) {
    return prisma.oauth_states.create({ data });
  }

  async consume(stateHash: string, purposes: oauth_purpose[]) {
    const existing = await prisma.oauth_states.findUnique({ where: { state_hash: stateHash } });
    if (!existing || !purposes.includes(existing.purpose)) {
      throw new AppError('AUTH_OAUTH_STATE_INVALID', 'The authorization request is invalid.', 400);
    }
    if (existing.used_at) {
      throw new AppError(
        'AUTH_OAUTH_STATE_USED',
        'The authorization request was already used.',
        400,
      );
    }
    if (existing.expires_at <= new Date()) {
      throw new AppError('AUTH_OAUTH_STATE_EXPIRED', 'The authorization request has expired.', 400);
    }
    const consumed = await prisma.oauth_states.updateMany({
      where: {
        id: existing.id,
        used_at: null,
        expires_at: { gt: new Date() },
        purpose: { in: purposes },
      },
      data: { used_at: new Date() },
    });
    if (consumed.count !== 1) {
      throw new AppError(
        'AUTH_OAUTH_STATE_USED',
        'The authorization request was already used.',
        400,
      );
    }
    return existing;
  }
}

export const oauthStateRepository = new OAuthStateRepository();
