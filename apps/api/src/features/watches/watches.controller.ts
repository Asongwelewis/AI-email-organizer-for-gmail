import type { Request, Response } from 'express';
import { z } from 'zod';

import { AppError } from '@api/errors/AppError.js';
import { watchesService } from './watches.service.js';

const addBody = z.object({ facetKey: z.string().min(3).max(400) });

function noStore(response: Response): void {
  response.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
}

function facetKeyParam(request: Request): string {
  const key = String(request.params['facetKey'] ?? '');
  if (key.length < 3 || key.length > 400) {
    throw new AppError('WATCH_VALIDATION_FAILED', 'That is not a folder.', 400);
  }
  return key;
}

export const watchesController = {
  async keys(request: Request, response: Response): Promise<void> {
    noStore(response);
    response.json({ keys: await watchesService.keys(request.auth!.user.id) });
  },

  async add(request: Request, response: Response): Promise<void> {
    const parsed = addBody.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('WATCH_VALIDATION_FAILED', 'That is not a folder.', 400);
    }
    const facetKey = await watchesService.add(request.auth!.user.id, parsed.data.facetKey);
    response.status(201).json({ facetKey });
  },

  async remove(request: Request, response: Response): Promise<void> {
    await watchesService.remove(request.auth!.user.id, facetKeyParam(request));
    response.status(204).end();
  },
};
