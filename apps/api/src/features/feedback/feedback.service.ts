import type { feedback_kind } from '@prisma/client';

import { prisma } from '@api/database/prisma.js';
import { logger } from '@api/config/logger.js';

export interface FeedbackSubmission {
  kind: feedback_kind;
  message: string;
  contact?: string | undefined;
  page?: string | undefined;
  userId?: string | undefined;
}

export const feedbackService = {
  /**
   * Records one submission and answers nothing but success.
   *
   * The id is deliberately not returned. It is a database key, it tells the sender nothing they
   * can use, and handing out row identifiers from the one table strangers can write to invites
   * probing for how many there are.
   */
  async submit(submission: FeedbackSubmission): Promise<void> {
    await prisma.feedback.create({
      data: {
        kind: submission.kind,
        message: submission.message,
        contact: submission.contact ?? null,
        page: submission.page ?? null,
        user_id: submission.userId ?? null,
      },
    });

    /*
     * The kind and whether it was signed in, and nothing else. What somebody wrote is theirs, and
     * the logging pipeline is the wrong place for it — a "PROBLEM" report is exactly the kind of
     * message that quotes an error, an address, or a subject line.
     */
    logger.info(
      { kind: submission.kind, authenticated: Boolean(submission.userId) },
      'feedback received',
    );
  },
};
