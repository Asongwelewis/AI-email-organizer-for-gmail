import { AppError, type ErrorCode } from '@api/errors/AppError.js';

interface GoogleErrorShape {
  code?: number | string;
  response?: {
    status?: number;
    headers?: unknown;
    data?: { error?: { errors?: Array<{ reason?: string }> } };
  };
}

export class GmailRequestError extends AppError {
  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number,
    public readonly retryable: boolean,
    /** How long Gmail asked us to wait, when it said. */
    public readonly retryAfterMs: number | null = null,
  ) {
    super(code, message, statusCode);
  }
}

/** `Retry-After` is either a number of seconds or an HTTP date. */
export function parseRetryAfter(value: unknown, now = Date.now()): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** Gaxios hands back a `Headers` object; older paths, a plain record. */
function retryAfterOf(candidate: GoogleErrorShape): number | null {
  const headers = candidate.response?.headers as
    { get?: (name: string) => unknown; [name: string]: unknown } | undefined;
  if (!headers) return null;
  const value =
    typeof headers.get === 'function' ? headers.get('retry-after') : headers['retry-after'];
  return parseRetryAfter(value);
}

export function classifyGmailError(error: unknown): GmailRequestError {
  if (error instanceof GmailRequestError) return error;
  if (error instanceof AppError) {
    return new GmailRequestError(error.code, error.message, error.statusCode, false);
  }
  const candidate = error as GoogleErrorShape;
  const status = Number(candidate.response?.status ?? candidate.code);
  const reasons = candidate.response?.data?.error?.errors?.map((entry) => entry.reason ?? '') ?? [];
  if (status === 401) {
    return new GmailRequestError(
      'GMAIL_REAUTH_REQUIRED',
      'Reconnect Gmail to continue.',
      409,
      false,
    );
  }
  if (status === 429 || reasons.some((reason) => /rateLimit|userRateLimit/i.test(reason))) {
    return new GmailRequestError(
      'GMAIL_RATE_LIMITED',
      'Gmail is busy. Please try again shortly.',
      503,
      true,
      retryAfterOf(candidate),
    );
  }
  if (status === 403) {
    return new GmailRequestError(
      'GMAIL_PERMISSION_DENIED',
      'Gmail permission is insufficient. Reconnect Gmail.',
      403,
      false,
    );
  }
  if (status === 404) {
    return new GmailRequestError(
      'GMAIL_HISTORY_EXPIRED',
      'The Gmail resource or history checkpoint is no longer available.',
      409,
      false,
    );
  }
  if (status >= 500 || !Number.isFinite(status)) {
    return new GmailRequestError(
      'GMAIL_UPSTREAM_UNAVAILABLE',
      'Gmail is temporarily unavailable.',
      503,
      true,
    );
  }
  return new GmailRequestError('GMAIL_SYNC_FAILED', 'Gmail synchronization failed.', 502, false);
}

export function isHistoryExpired(error: unknown): boolean {
  if (error instanceof AppError && error.code === 'GMAIL_HISTORY_EXPIRED') return true;
  const candidate = error as GoogleErrorShape;
  return Number(candidate.response?.status ?? candidate.code) === 404;
}
