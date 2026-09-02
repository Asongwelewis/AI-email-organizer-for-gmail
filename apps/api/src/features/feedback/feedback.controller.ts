import type { Request, Response } from 'express';
import { z } from 'zod';

import { AppError } from '@api/errors/AppError.js';
import { sessionService } from '@api/sessions/session.service.js';
import { feedbackService } from './feedback.service.js';

/**
 * The bounds match the table's check constraints exactly. A floor of ten characters is not
 * gatekeeping: "it's broken" is not actionable and the form says so before it is submitted.
 */
const submission = z
  .object({
    kind: z.enum(['PROBLEM', 'IDEA', 'PRAISE', 'OTHER']),
    message: z.string().trim().min(10).max(4000),
    /*
     * Optional, and an empty string means "no thanks" rather than a validation failure — a form
     * field somebody tabbed through and left blank arrives as `''`, and rejecting that would be
     * refusing feedback over a detail the sender deliberately skipped.
     */
    contact: z
      .string()
      .trim()
      .max(320)
      .email()
      .optional()
      .or(z.literal('').transform(() => undefined)),
    /*
     * A route, and only a route. Ours carry facet values, search phrases and message ids in the
     * query string, so anything past the path is dropped rather than trusted — this field is a
     * debugging convenience and not worth the chance of storing somebody's search.
     */
    page: z
      .string()
      .trim()
      .max(120)
      .regex(/^\/[A-Za-z0-9\-_/]*$/, 'not a route')
      .optional(),
  })
  .strict();

export const feedbackController = {
  async submit(request: Request, response: Response): Promise<void> {
    const parsed = submission.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(
        'FEEDBACK_VALIDATION_FAILED',
        'Tell us a little more — at least a sentence, and under 4000 characters.',
        400,
      );
    }

    /*
     * Attribution is a bonus, never a requirement. The whole point is that somebody handed the
     * link can write back, so a missing, expired or revoked session is not an error here — it just
     * means the row has no user on it.
     */
    let userId: string | undefined;
    try {
      const auth = await sessionService.authenticate(request);
      userId = auth.user.id;
    } catch {
      userId = undefined;
    }

    await feedbackService.submit({ ...parsed.data, userId });

    response.status(201).json({ received: true });
  },
};
