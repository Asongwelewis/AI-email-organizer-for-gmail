import type { Request, Response } from 'express';
import { z } from 'zod';

import { isSignInAllowed } from '@api/auth/sign-in-policy.js';
import { AppError, authenticationRequired } from '@api/errors/AppError.js';
import { setSessionCookie } from '@api/sessions/session.cookies.js';
import { sessionService } from '@api/sessions/session.service.js';
import { desktopPairingService } from './desktop-pairing.service.js';

const completion = z
  .object({
    pairingId: z.string().uuid(),
    pollSecret: z.string().min(32).max(200),
  })
  .strict();

const approval = z.object({ code: z.string().trim().min(1).max(32) }).strict();

export const desktopPairingController = {
  async start(_request: Request, response: Response): Promise<void> {
    response.status(201).json(await desktopPairingService.start());
  },

  /**
   * The island's poll. While the code waits it answers `pending`; once it was typed, it issues the
   * island a session of its own — in the same cookie a sign-in sets, so every other route treats
   * the island exactly as it treats the browser.
   */
  async complete(request: Request, response: Response): Promise<void> {
    const parsed = completion.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('DESKTOP_PAIRING_INVALID', 'That pairing is not valid.', 400);
    }
    const outcome = await desktopPairingService.complete(
      parsed.data.pairingId,
      parsed.data.pollSecret,
    );
    if (outcome.status !== 'connected') {
      response.status(outcome.status === 'pending' ? 202 : 410).json({ status: outcome.status });
      return;
    }
    const { rawToken, session } = await sessionService.create(outcome.userId, request);
    // The person who typed the code was signed in a moment ago; this only matters if the private
    // list changed in between.
    if (session.user.status !== 'ACTIVE' || !isSignInAllowed(session.user.email)) {
      throw authenticationRequired();
    }
    setSessionCookie(response, rawToken, new Date(session.expiresAt));
    response.json({ status: 'connected' });
  },

  async approve(request: Request, response: Response): Promise<void> {
    const parsed = approval.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(
        'DESKTOP_CODE_INVALID',
        'The code has eight letters, as the island shows it.',
        400,
      );
    }
    const userId = request.auth?.user.id;
    if (!userId) throw authenticationRequired();
    await desktopPairingService.approve(userId, parsed.data.code);
    response.json({ approved: true });
  },
};
