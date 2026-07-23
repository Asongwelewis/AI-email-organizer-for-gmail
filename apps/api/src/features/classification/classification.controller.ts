import type { Request, Response } from 'express';
import { z } from 'zod';

import { AppError } from '@api/errors/AppError.js';
import { CLASSIFICATION_CATEGORIES, RECOMMENDED_ACTIONS } from './classification-taxonomy.js';
import { classificationService } from './classification.service.js';

const uuid = z.string().uuid();
const filtersSchema = z.object({
  category: z.enum(CLASSIFICATION_CATEGORIES).optional(),
  recommendedAction: z.enum(RECOMMENDED_ACTIONS).optional(),
  requiresReview: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  status: z.enum(['PENDING', 'COMPLETED', 'FAILED', 'NEEDS_REVIEW', 'SUPERSEDED']).optional(),
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const correctionSchema = z
  .object({
    category: z.enum(CLASSIFICATION_CATEGORIES),
    recommendedAction: z.enum(RECOMMENDED_ACTIONS),
    feedbackReason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(
      'CLASSIFICATION_VALIDATION_FAILED',
      'Classification request validation failed.',
      400,
    );
  }
  return result.data;
}

export class ClassificationController {
  async status(request: Request, response: Response): Promise<void> {
    response.json(await classificationService.status(request.auth!.user.id));
  }

  async results(request: Request, response: Response): Promise<void> {
    response.json(
      await classificationService.results(
        request.auth!.user.id,
        parse(filtersSchema, request.query),
      ),
    );
  }

  async result(request: Request, response: Response): Promise<void> {
    response.json(
      await classificationService.result(request.auth!.user.id, parse(uuid, request.params['id'])),
    );
  }

  async run(request: Request, response: Response): Promise<void> {
    response.json(await classificationService.run(request.auth!.user.id));
  }

  async reclassify(request: Request, response: Response): Promise<void> {
    response.json(
      await classificationService.reclassify(
        request.auth!.user.id,
        parse(uuid, request.params['messageId']),
      ),
    );
  }

  async correct(request: Request, response: Response): Promise<void> {
    const correction = parse(correctionSchema, request.body);
    response
      .status(201)
      .json(
        await classificationService.correct(
          request.auth!.user.id,
          parse(uuid, request.params['id']),
          correction.category,
          correction.recommendedAction,
          correction.feedbackReason,
        ),
      );
  }
}

export const classificationController = new ClassificationController();
