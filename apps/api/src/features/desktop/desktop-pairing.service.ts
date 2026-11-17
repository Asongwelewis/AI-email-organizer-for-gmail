import { randomInt } from 'node:crypto';

import { prisma } from '@api/database/prisma.js';
import { AppError } from '@api/errors/AppError.js';
import { sha256 } from '@api/security/hashing.service.js';
import { generateSecureToken } from '@api/security/random.service.js';

/** How long a person has to type the code before the island has to start again. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;

/**
 * Consonants only, without the ones that are read aloud or mistyped as one another: no vowels, so
 * a code never spells a word, and no L next to an I that does not exist. Twenty letters, eight of
 * them: about 2.6 × 10^10 codes, against a ten-minute window and an approval that needs a session.
 */
const ALPHABET = 'BCDFGHJKMNPQRSTVWXZ';
const CODE_LENGTH = 8;

/** What a person typed, as it was shown: upper case, letters only. "bcdf-ghjk" is "BCDFGHJK". */
export function normalizeUserCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z]/g, '');
}

function newUserCode(): string {
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }
  return code;
}

/** "BCDFGHJK" as the island shows it: two groups of four. */
export function displayUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export type PairingOutcome =
  { status: 'pending' } | { status: 'expired' } | { status: 'connected'; userId: string };

/**
 * Pairing the desktop island with an account, the way a television pairs with a phone.
 *
 * Google refuses sign-in inside a desktop program, so the island never signs in. It starts a
 * pairing and shows the code; the person types that code into AMO in their own browser, where they
 * are already signed in; the island's next poll — carrying a secret only it holds — finds the row
 * approved and receives a session of its own.
 *
 * The code is typed, never carried in a link: a link would let anyone who started a pairing send
 * it to somebody signed in and receive their session the moment they clicked. Both secrets are
 * stored hashed, a row is approved once and completed once, and it lives ten minutes.
 */
export const desktopPairingService = {
  async start(now = new Date()) {
    const pollSecret = generateSecureToken();
    const userCode = newUserCode();
    const row = await prisma.desktop_pairings.create({
      data: {
        poll_secret_hash: sha256(pollSecret),
        user_code_hash: sha256(userCode),
        expires_at: new Date(now.getTime() + PAIRING_TTL_MS),
      },
    });
    return {
      pairingId: row.id,
      pollSecret,
      userCode: displayUserCode(userCode),
      expiresAt: row.expires_at.toISOString(),
    };
  },

  /** The signed-in person typed the code their island shows. */
  async approve(userId: string, typed: string, now = new Date()): Promise<void> {
    const code = normalizeUserCode(typed);
    if (code.length !== CODE_LENGTH) {
      throw new AppError(
        'DESKTOP_CODE_INVALID',
        'The code has eight letters, as the island shows it.',
        400,
      );
    }
    const approved = await prisma.desktop_pairings.updateMany({
      where: {
        user_code_hash: sha256(code),
        approved_at: null,
        expires_at: { gt: now },
      },
      data: { approved_user_id: userId, approved_at: now },
    });
    if (approved.count === 0) {
      throw new AppError(
        'DESKTOP_CODE_NOT_FOUND',
        'No island is waiting for that code, or it has expired. Check the code on the island.',
        404,
      );
    }
  },

  /**
   * The island asking whether its code was typed yet. Connected exactly once: the row is claimed
   * with a conditional update, so two polls racing cannot both receive a session.
   */
  async complete(pairingId: string, pollSecret: string, now = new Date()): Promise<PairingOutcome> {
    const row = await prisma.desktop_pairings.findFirst({
      where: { id: pairingId, poll_secret_hash: sha256(pollSecret) },
    });
    if (!row || row.completed_at) return { status: 'expired' };
    if (!row.approved_user_id) {
      return row.expires_at > now ? { status: 'pending' } : { status: 'expired' };
    }
    const claimed = await prisma.desktop_pairings.updateMany({
      where: { id: row.id, completed_at: null },
      data: { completed_at: now },
    });
    if (claimed.count !== 1) return { status: 'expired' };
    return { status: 'connected', userId: row.approved_user_id };
  },
};
