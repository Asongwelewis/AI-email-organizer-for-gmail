import React from 'react';
import * as Sentry from '@sentry/react';
import {
  createRoutesFromChildren,
  matchRoutes,
  useLocation,
  useNavigationType,
} from 'react-router-dom';

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/+$/, '');
const tracePropagationTargets: Array<string | RegExp> = ['localhost', /^\/api\//];

if (apiBaseUrl) {
  tracePropagationTargets.push(apiBaseUrl);
}

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
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
    queryParams: false,
    httpBodies: [],
  },
});
