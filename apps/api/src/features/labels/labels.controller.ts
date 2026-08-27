import type { Request, Response } from 'express';
import { z } from 'zod';

import { AppError } from '@api/errors/AppError.js';
import { labelsService } from './labels.service.js';

const uuid = z.string().uuid();
const leafName = z.string().min(1).max(60);

/**
 * Confirmation is either approval of a proposed tree or manual folder creation. Both end in the
 * same place — a row in user_labels and a Gmail label for each leaf — but only the plan form can
 * bring routing rules with it.
 */
const confirmSchema = z.union([
  z
    .object({
      planId: uuid,
      nodeIds: z.array(uuid).max(200).optional(),
    })
    .strict(),
  z
    .object({
      labels: z
        .array(
          z
            .object({
              leafName,
              parentId: uuid.nullish(),
              source: z.enum(['AI_PROPOSED', 'USER_CREATED']),
            })
            .strict(),
        )
        .min(1)
        .max(200),
    })
    .strict(),
]);
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
    const userId = request.auth!.user.id;
    response.json(
      'planId' in body
        ? await labelsService.approvePlan(userId, {
            planId: body.planId,
            nodeIds: body.nodeIds,
          })
        : await labelsService.confirm(userId, body.labels),
    );
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
