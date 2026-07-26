import type { Request, Response } from 'express';

import { env } from '@api/config/env.js';
import { logger, safeErrorDetails } from '@api/config/logger.js';
import { frontendUrl } from '@api/security/safe-redirect.js';
import { googleGmailService } from './google-login.service.js';
import { sessionService } from '@api/sessions/session.service.js';

export class GoogleIntegrationController {
  async connect(request: Request, response: Response): Promise<void> {
    response.redirect(await googleGmailService.beginConnection(request, request.query['redirect']));
  }

  async callback(request: Request, response: Response): Promise<void> {
    if (typeof request.query['error'] === 'string') {
      const redirectPath = await googleGmailService.denyConnection(request, request.query['state']);
      response.redirect(frontendUrl(env.WEB_APP_URL, redirectPath, 'gmail_denied'));
      return;
    }
    try {
      request.auth = await sessionService.authenticate(request);
      const result = await googleGmailService.completeConnection(
        request,
        request.query['code'],
        request.query['state'],
      );
      response.redirect(frontendUrl(env.WEB_APP_URL, result.redirectPath, result.status));
    } catch (error) {
      logger.warn(
        {
          requestId: request.requestId,
          operation: 'gmail_oauth_callback',
          ...safeErrorDetails(error),
        },
        'Gmail OAuth callback redirected with failure',
      );
      response.redirect(
        frontendUrl(env.WEB_APP_URL, '/settings/connections', 'gmail_connection_failed'),
      );
    }
  }

  async status(request: Request, response: Response): Promise<void> {
    response.setHeader('Cache-Control', 'private, no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Expires', '0');
    response.json(await googleGmailService.status(request.auth!.user.id));
  }

  async disconnect(request: Request, response: Response): Promise<void> {
    await googleGmailService.disconnect(request);
    response.json({ success: true });
  }
}

export const googleIntegrationController = new GoogleIntegrationController();
