import type { NextFunction, Request, Response } from 'express';

import { sessionService } from './session.service.js';

export async function requireSession(
  request: Request,
  _response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    request.auth = await sessionService.authenticate(request);
    next();
  } catch (error) {
    next(error);
  }
}
