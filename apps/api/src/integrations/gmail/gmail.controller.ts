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

  async initialSync(request: Request, response: Response): Promise<void> {
    response.json(await gmailSyncService.initialSync(request.auth!.user.id));
  }

  async incrementalSync(request: Request, response: Response): Promise<void> {
    response.json(await gmailSyncService.incrementalSync(request.auth!.user.id));
  }

  async status(request: Request, response: Response): Promise<void> {
    response.json(await gmailSyncService.status(request.auth!.user.id));
  }
}

export const gmailController = new GmailController();
