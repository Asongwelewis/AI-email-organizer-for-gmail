import * as Sentry from '@sentry/node';
import type { Express } from 'express';

export function isSentryEnabled(): boolean {
  return Sentry.isInitialized() && Sentry.isEnabled();
}

export function setupApiSentryErrorHandler(app: Express): void {
  if (!isSentryEnabled()) return;
  Sentry.setupExpressErrorHandler(app, {
    shouldHandleError(error) {
      const rawStatus = error.statusCode ?? error.status_code ?? error.status ?? 500;
      const status = Number(rawStatus);
      return !Number.isFinite(status) || status >= 500;
    },
  });
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
