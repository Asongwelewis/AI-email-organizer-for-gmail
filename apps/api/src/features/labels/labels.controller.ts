import type { Request, Response } from 'express';
import { z } from 'zod';

import { AppError } from '@api/errors/AppError.js';
import { labelsService } from './labels.service.js';

const uuid = z.string().uuid();
const leafName = z.string().min(1).max(60);
const confirmSchema = z
  .object({
    labels: z
      .array(
        z
          .object({
            leafName,
            source: z.enum(['AI_PROPOSED', 'USER_CREATED']),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
const renameSchema = z.object({ leafName }).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError('LABEL_VALIDATION_FAILED', 'Label request validation failed.', 400);
  }
  return parsed.data;
}

export class LabelsController {
  async list(request: Request, response: Response): Promise<void> {
    response.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    response.json(await labelsService.list(request.auth!.user.id));
  }

  async propose(request: Request, response: Response): Promise<void> {
    response.json(await labelsService.propose(request.auth!.user.id));
  }

  async confirm(request: Request, response: Response): Promise<void> {
    const body = parse(confirmSchema, request.body);
    response.json(await labelsService.confirm(request.auth!.user.id, body.labels));
  }

  async rename(request: Request, response: Response): Promise<void> {
    const body = parse(renameSchema, request.body);
    response.json(
      await labelsService.rename(
        request.auth!.user.id,
        parse(uuid, request.params['id']),
        body.leafName,
      ),
    );
  }

  async remove(request: Request, response: Response): Promise<void> {
    response.json(
      await labelsService.remove(request.auth!.user.id, parse(uuid, request.params['id'])),
    );
  }
}

export const labelsController = new LabelsController();
