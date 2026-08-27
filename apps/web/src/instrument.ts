import React from 'react';
import * as Sentry from '@sentry/react';
import {
  createRoutesFromChildren,
  matchRoutes,
  useLocation,
  useNavigationType,
} from 'react-router-dom';

import {
  isSentryDsnConfigured,
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  scrubSentrySpan,
} from '@web/observability/sentryPrivacy';

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/+$/, '');
const tracePropagationTargets: Array<string | RegExp> = ['localhost', /^\/api\//];
const sentryDsn = import.meta.env.VITE_SENTRY_DSN?.trim();

export const isSentryEnabled = import.meta.env.MODE !== 'test' && isSentryDsnConfigured(sentryDsn);

if (apiBaseUrl) {
  tracePropagationTargets.push(apiBaseUrl);
}

if (isSentryEnabled) {
  Sentry.init({
    dsn: sentryDsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_APP_VERSION,
    integrations: [
      Sentry.reactRouterV7BrowserTracingIntegration({
        useEffect: React.useEffect,
        useLocation,
        useNavigationType,
        createRoutesFromChildren,
        matchRoutes,
      }),
    ],
    tracesSampler: ({ inheritOrSampleWith }) => inheritOrSampleWith(import.meta.env.PROD ? 0.1 : 1),
    tracePropagationTargets,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: {
        request: false,
        response: false,
      },
      urlQueryParams: false,
      httpBodies: [],
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
    },
    beforeSend: scrubSentryEvent,
    beforeSendTransaction: scrubSentryEvent,
    beforeSendSpan: scrubSentrySpan,
    beforeBreadcrumb: scrubSentryBreadcrumb,
  });
}

export function createReactErrorHandler():
  ((error: unknown, errorInfo: { componentStack?: string | undefined }) => void) | undefined {
  if (!isSentryEnabled) return undefined;
  const sentryHandler = Sentry.reactErrorHandler();
  return (error, errorInfo) => {
    sentryHandler(error, { componentStack: errorInfo.componentStack ?? null });
  };
}

export function captureRouteException(error: Error): string | undefined {
  if (!isSentryEnabled) return undefined;
  return Sentry.captureException(error, {
    tags: { source: 'react-router-error-element' },
  });
}

export function captureRouteFailure(status: number): string | undefined {
  if (!isSentryEnabled || status < 500) return undefined;
  return Sentry.captureMessage('React Router handled a server route failure', {
    level: 'error',
    tags: { source: 'react-router-error-element', http_status: String(status) },
  });
}
