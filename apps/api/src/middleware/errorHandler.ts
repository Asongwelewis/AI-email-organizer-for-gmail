import type { NextFunction, Request, Response } from 'express';

import { env } from '@api/config/env.js';
import { logger } from '@api/config/logger.js';
import { AppError } from '@api/errors/AppError.js';

export function errorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction,
): void {
  const appError = error instanceof AppError ? error : new AppError('Unexpected server error', 500);
  const statusCode = appError.statusCode;

  if (env.NODE_ENV !== 'test') {
    logger.error({ error }, appError.message);
  }

  response.status(statusCode).json({
    message: appError.message,
    status: 'error',
  });
}
