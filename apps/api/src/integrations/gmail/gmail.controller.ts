import type { Request, Response } from 'express';

import { gmailSyncService } from './gmail.service.js';

export class GmailController {
  async profile(request: Request, response: Response): Promise<void> {
    response.json(await gmailSyncService.profile(request.auth!.user.id));
  }

  async labels(request: Request, response: Response): Promise<void> {
    response.json({ labels: await gmailSyncService.labels(request.auth!.user.id) });
  }

  async initializeLabels(request: Request, response: Response): Promise<void> {
    response.json(await gmailSyncService.initializeLabels(request.auth!.user.id));
  }

  /**
   * 202: a full backfill walks every page of the mailbox, so the client gets a run id and polls
   * `GET /api/activity/runs/:id` rather than holding a request that cannot return in time.
   */
  async initialSync(request: Request, response: Response): Promise<void> {
    response.status(202).json(await gmailSyncService.startInitialSync(request.auth!.user.id));
  }

  async incrementalSync(request: Request, response: Response): Promise<void> {
    response.json(await gmailSyncService.incrementalSync(request.auth!.user.id));
  }

  async status(request: Request, response: Response): Promise<void> {
    response.json(await gmailSyncService.status(request.auth!.user.id));
  }
}

export const gmailController = new GmailController();
