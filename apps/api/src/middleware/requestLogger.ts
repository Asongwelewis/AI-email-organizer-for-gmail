import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import { logger } from '@api/config/logger.js';

export function requestLogger(request: Request, response: Response, next: NextFunction): void {
  const startedAt = Date.now();
  request.requestId = request.get('x-request-id')?.slice(0, 100) || randomUUID();
  response.setHeader('x-request-id', request.requestId);

  response.on('finish', () => {
    logger.info(
      {
        requestId: request.requestId,
        method: request.method,
        path: request.path,
        statusCode: response.statusCode,
        durationMs: Date.now() - startedAt,
      },
      'request completed',
    );
  });
  next();
}
