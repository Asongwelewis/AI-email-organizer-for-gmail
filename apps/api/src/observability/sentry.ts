import * as Sentry from '@sentry/node';
import type { Express } from 'express';

import { CONFIGURATION_REFUSALS, type ErrorCode } from '@api/errors/AppError.js';

export function isSentryEnabled(): boolean {
  return Sentry.isInitialized() && Sentry.isEnabled();
}

/**
 * Server faults, and only server faults.
 *
 * A 5xx is the right shape for "this request could not be served", but it does not by itself mean
 * something went wrong: a feature the operator turned off answers 503 on purpose, on a path that
 * expects it, and the screen shows the code so a person can act on it. Reporting those files a
 * fresh issue on every click of a disabled button — and with the Gmail export off by default, that
 * is a steady drip that buries the faults worth reading.
 *
 * Everything else at 5xx still reports, including provider failures: Gemini breaking is a genuine
 * thing to be told about, even though it is also a 503.
 *
 * Exported so the rule can be tested. It is the difference between a useful Sentry project and one
 * nobody opens.
 */
export function shouldReportToSentry(error: {
  code?: unknown;
  statusCode?: unknown;
  status_code?: unknown;
  status?: unknown;
}): boolean {
  const code = error.code;
  if (typeof code === 'string' && CONFIGURATION_REFUSALS.has(code as ErrorCode)) return false;
  const rawStatus = error.statusCode ?? error.status_code ?? error.status ?? 500;
  const status = Number(rawStatus);
  return !Number.isFinite(status) || status >= 500;
}

export function setupApiSentryErrorHandler(app: Express): void {
  if (!isSentryEnabled()) return;
  Sentry.setupExpressErrorHandler(app, { shouldHandleError: shouldReportToSentry });
}

export function captureApiException(
  error: unknown,
  tags: Record<string, string>,
): string | undefined {
  if (!isSentryEnabled()) return undefined;

  return Sentry.captureException(error, {
    tags: { service: 'mailmind-api', ...tags },
  });
}

export async function closeSentry(timeoutMs = 2_000): Promise<void> {
  if (!isSentryEnabled()) return;
  await Sentry.close(timeoutMs);
}
