import type { Request, Response } from 'express';

import { env } from '@api/config/env.js';
import { frontendUrl } from '@api/security/safe-redirect.js';
import { googleGmailService } from './google-login.service.js';

export class GoogleIntegrationController {
  async connect(request: Request, response: Response): Promise<void> {
    response.redirect(await googleGmailService.beginConnection(request, request.query['redirect']));
  }

  async callback(request: Request, response: Response): Promise<void> {
    if (typeof request.query['error'] === 'string') {
      await googleGmailService.denyConnection(request, request.query['state']);
      response.redirect(frontendUrl(env.WEB_APP_URL, '/settings/connections', 'gmail_denied'));
      return;
    }
    try {
      const result = await googleGmailService.completeConnection(
        request,
        request.query['code'],
        request.query['state'],
      );
      response.redirect(frontendUrl(env.WEB_APP_URL, result.redirectPath, result.status));
    } catch {
      response.redirect(frontendUrl(env.WEB_APP_URL, '/settings/connections', 'gmail_failed'));
    }
  }

  async status(request: Request, response: Response): Promise<void> {
    response.json(await googleGmailService.status(request.auth!.user.id));
  }

  async disconnect(request: Request, response: Response): Promise<void> {
    await googleGmailService.disconnect(request);
    response.json({ success: true });
  }
}

export const googleIntegrationController = new GoogleIntegrationController();
