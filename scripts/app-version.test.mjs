import assert from 'node:assert/strict';
import test from 'node:test';

import { appVersionEnvironment, resolveAppVersion } from './app-version.mjs';

test('derives one shared release from the deployment commit', () => {
  const environment = appVersionEnvironment({ GITHUB_SHA: 'abc123' });

  assert.equal(environment.APP_VERSION, 'mailmind@abc123');
  assert.equal(environment.VITE_APP_VERSION, environment.APP_VERSION);
  assert.equal(environment.SENTRY_RELEASE, environment.APP_VERSION);
});

test('accepts a matching explicit release', () => {
  assert.equal(
    resolveAppVersion({
      APP_VERSION: 'mailmind@release',
      VITE_APP_VERSION: 'mailmind@release',
      SENTRY_RELEASE: 'mailmind@release',
    }),
    'mailmind@release',
  );
});

test('rejects frontend and backend release drift', () => {
  assert.throws(
    () =>
      resolveAppVersion({
        APP_VERSION: 'mailmind@backend',
        VITE_APP_VERSION: 'mailmind@frontend',
      }),
    /must use the same release value/,
  );
});
