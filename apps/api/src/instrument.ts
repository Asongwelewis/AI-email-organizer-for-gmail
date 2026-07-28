import 'dotenv/config';

import * as Sentry from '@sentry/node';

import {
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  scrubSentrySpan,
} from './observability/sentryPrivacy.js';

function optional(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function appVersion(): string {
  const explicit = [
    optional(process.env['APP_VERSION']),
    optional(process.env['SENTRY_RELEASE']),
  ].filter(Boolean);
  const releases = [...new Set(explicit)];
  if (releases.length > 1) {
    throw new Error('APP_VERSION and SENTRY_RELEASE must use the same release value.');
  }
  if (releases[0]) return releases[0];

  const commit = optional(process.env['RENDER_GIT_COMMIT'] ?? process.env['GITHUB_SHA']);
  return commit ? `mailmind@${commit}` : 'mailmind@0.1.0';
}

function traceSampleRate(): number {
  const configured = optional(process.env['SENTRY_TRACES_SAMPLE_RATE']);
  if (!configured) return process.env['NODE_ENV'] === 'production' ? 0.1 : 1;
  const rate = Number(configured);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new Error('SENTRY_TRACES_SAMPLE_RATE must be a number from 0 through 1.');
  }
  return rate;
}

const release = appVersion();
process.env['APP_VERSION'] = release;
process.env['SENTRY_RELEASE'] = release;

const dsn = optional(process.env['SENTRY_DSN']);

if (dsn) {
  Sentry.init({
    dsn,
    environment:
      optional(process.env['SENTRY_ENVIRONMENT']) ?? process.env['NODE_ENV'] ?? 'development',
    release,
    tracesSampler: ({ name, inheritOrSampleWith }) => {
      if (/\/(?:health|ready)(?:\b|\/)/i.test(name)) return 0;
      return inheritOrSampleWith(traceSampleRate());
    },
    tracePropagationTargets: [],
    ignoreTransactions: [/\/health(?:\b|\/)/i, /\/ready(?:\b|\/)/i],
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
    },
    integrations(defaultIntegrations) {
      return [
        ...defaultIntegrations.filter((integration) => integration.name !== 'RequestData'),
        Sentry.requestDataIntegration({
          include: {
            cookies: false,
            data: false,
            headers: false,
            ip: false,
            query_string: false,
            url: true,
          },
        }),
      ];
    },
    beforeSend: scrubSentryEvent,
    beforeSendTransaction: scrubSentryEvent,
    beforeSendSpan: scrubSentrySpan,
    beforeBreadcrumb: scrubSentryBreadcrumb,
    debug: process.env['SENTRY_DEBUG'] === 'true',
  });
}
