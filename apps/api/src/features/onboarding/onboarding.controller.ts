import type { Request, Response } from 'express';

import { onboardingService } from './onboarding.service.js';

function noStore(response: Response): void {
  response.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
}

export class OnboardingController {
  async status(request: Request, response: Response): Promise<void> {
    noStore(response);
    response.json(await onboardingService.status(request.auth!.user.id));
  }

  /**
   * Starts onboarding, or joins the run in flight, and answers with the status the client would
   * otherwise poll for next. 202 while there is work going on; 200 once there is none.
   */
  async start(request: Request, response: Response): Promise<void> {
    noStore(response);
    const userId = request.auth!.user.id;
    const started = await onboardingService.begin(userId);
    response.status(started ? 202 : 200).json(await onboardingService.status(userId));
  }
}

export const onboardingController = new OnboardingController();
