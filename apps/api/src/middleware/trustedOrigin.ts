import type { NextFunction, Request, Response } from 'express';

import { isAllowedWebOrigin } from '@api/config/webOrigins.js';
import { AppError } from '@api/errors/AppError.js';

/**
 * SameSite cookies reduce CSRF exposure, while this check rejects browser
 * mutations explicitly initiated by any origin outside the trusted UI allowlist.
 * Requests without Origin remain available to non-browser clients and health tooling.
 */
export function requireTrustedOrigin(
  request: Request,
  _response: Response,
  next: NextFunction,
): void {
  const origin = request.get('origin');
  if (origin && !isAllowedWebOrigin(origin)) {
    next(new AppError('CSRF_ORIGIN_INVALID', 'The request origin is not allowed.', 403));
    return;
  }
  next();
}
