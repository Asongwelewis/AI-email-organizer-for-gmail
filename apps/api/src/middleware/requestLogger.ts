import type { NextFunction, Request, Response } from 'express';

import { logger } from '@api/config/logger.js';

export function requestLogger(request: Request, response: Response, next: NextFunction): void {
  const startedAt = Date.now();

  response.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    logger.info(
      {
        method: request.method,
        path: request.originalUrl,
        statusCode: response.statusCode,
        durationMs,
      },
      'request completed',
    );
  });

  next();
}
