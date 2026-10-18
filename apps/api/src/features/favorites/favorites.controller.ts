import type { Request, Response } from 'express';
import { z } from 'zod';

import { AppError } from '@api/errors/AppError.js';
import { PIVOT_FACETS, type PivotFacet } from '@api/features/label-discovery/pivot.js';
import { favoritesService } from './favorites.service.js';

const addBody = z.object({
  facetKey: z.string().min(3).max(400),
  order: z.array(z.enum(PIVOT_FACETS)).min(1).max(3),
});

function noStore(response: Response): void {
  response.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
}

function facetKeyParam(request: Request): string {
  const key = String(request.params['facetKey'] ?? '');
  if (key.length < 3 || key.length > 400) {
    throw new AppError('FAVORITE_VALIDATION_FAILED', 'That is not a folder.', 400);
  }
  return key;
}

export const favoritesController = {
  async list(request: Request, response: Response): Promise<void> {
    noStore(response);
    response.json({ items: await favoritesService.list(request.auth!.user.id) });
  },

  async keys(request: Request, response: Response): Promise<void> {
    noStore(response);
    response.json({ keys: await favoritesService.keys(request.auth!.user.id) });
  },

  async add(request: Request, response: Response): Promise<void> {
    const parsed = addBody.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('FAVORITE_VALIDATION_FAILED', 'That is not a folder.', 400);
    }
    const favorite = await favoritesService.add(
      request.auth!.user.id,
      parsed.data.facetKey,
      parsed.data.order as PivotFacet[],
    );
    response.status(201).json(favorite);
  },

  async remove(request: Request, response: Response): Promise<void> {
    await favoritesService.remove(request.auth!.user.id, facetKeyParam(request));
    response.status(204).end();
  },
};
