import type { NextFunction, Request, Response } from 'express';

import { logger } from '@api/config/logger.js';
import { AppError } from '@api/errors/AppError.js';

export function errorHandler(
  error: unknown,
  request: Request,
  response: Response,
  _next: NextFunction,
): void {
  const appError =
    error instanceof AppError
      ? error
      : new AppError('INTERNAL_SERVER_ERROR', 'An unexpected error occurred.', 500);
  if (appError.statusCode >= 500) {
    logger.error({ error, requestId: request.requestId, code: appError.code }, 'request failed');
  }
  response.status(appError.statusCode).json({
    error: { code: appError.code, message: appError.message },
  });
}
