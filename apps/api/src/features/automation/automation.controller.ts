import type { Request, Response } from 'express';
import { z } from 'zod';

import { AppError } from '@api/errors/AppError.js';
import { automationService } from './automation.service.js';

const uuid = z.string().uuid();
// The label must be one the account approved; the service checks it against user_labels.
const approvalSchema = z.object({ labelName: z.string().min(1).max(60) }).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(
      'AUTOMATION_VALIDATION_FAILED',
      'Automation request validation failed.',
      400,
    );
  }
  return parsed.data;
}

export class AutomationController {
  async status(request: Request, response: Response): Promise<void> {
    response.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    response.set('Pragma', 'no-cache');
    response.json(await automationService.status(request.auth!.user.id));
  }

  /**
   * 202: a filing run syncs the mailbox and then classifies in paced Gemini batches, well past any
   * browser timeout. The client gets a run id and polls `GET /api/activity/runs/:id`.
   */
  async run(request: Request, response: Response): Promise<void> {
    response.status(202).json(await automationService.start(request.auth!.user.id));
  }

  async review(request: Request, response: Response): Promise<void> {
    response.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    response.json(await automationService.reviewQueue(request.auth!.user.id));
  }

  async approve(request: Request, response: Response): Promise<void> {
    const body = parse(approvalSchema, request.body);
    response.json(
      await automationService.approve(
        request.auth!.user.id,
        parse(uuid, request.params['id']),
        body.labelName,
      ),
    );
  }

  async skip(request: Request, response: Response): Promise<void> {
    response.json(
      await automationService.skip(request.auth!.user.id, parse(uuid, request.params['id'])),
    );
  }
}

export const automationController = new AutomationController();
