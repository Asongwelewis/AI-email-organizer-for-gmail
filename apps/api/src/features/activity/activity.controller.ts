import type { Request, Response } from 'express';
import { z } from 'zod';

import { AppError } from '@api/errors/AppError.js';
import { activityService } from './activity.service.js';

const uuid = z.string().uuid();
const limitSchema = z.coerce.number().int().min(1).max(100).default(20);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError('ACTIVITY_VALIDATION_FAILED', 'Activity request validation failed.', 400);
  }
  return parsed.data;
}

export class ActivityController {
  async list(request: Request, response: Response): Promise<void> {
    response.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const limit = parse(limitSchema, request.query['limit'] ?? undefined);
    response.json(await activityService.recent(request.auth!.user.id, limit));
  }

  async detail(request: Request, response: Response): Promise<void> {
    response.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    response.json(
      await activityService.run(request.auth!.user.id, parse(uuid, request.params['id'])),
    );
  }
}

export const activityController = new ActivityController();
