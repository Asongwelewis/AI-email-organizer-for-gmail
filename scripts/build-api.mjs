import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { appVersionEnvironment } from './app-version.mjs';

const environment = appVersionEnvironment();
const apiRoot = process.cwd();
const distRoot = resolve(apiRoot, 'dist');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: apiRoot,
    env: environment,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function configured(name) {
  return Boolean(environment[name]?.trim());
}

function mapFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) files.push(...mapFiles(path));
    else if (path.endsWith('.map')) files.push(path);
  }
  return files;
}

run('tsc', ['-p', 'tsconfig.json']);
run('tsc-alias', ['-p', 'tsconfig.json']);

const uploadNames = ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT'];
const configuredUploadNames = uploadNames.filter(configured);
const uploadEnabled = configuredUploadNames.length === uploadNames.length;
const sentryRequired = environment.SENTRY_REQUIRE_CONFIG === 'true';

if (configuredUploadNames.length > 0 && !uploadEnabled) {
  throw new Error(
    `Incomplete Sentry source-map configuration. Missing: ${uploadNames
      .filter((name) => !configured(name))
      .join(', ')}`,
  );
}

if (sentryRequired && !configured('SENTRY_DSN')) {
  throw new Error('SENTRY_DSN is required for this production API build.');
}

if (sentryRequired && !uploadEnabled) {
  throw new Error(
    'SENTRY_AUTH_TOKEN, SENTRY_ORG, and SENTRY_PROJECT are required for this production API build.',
  );
}

if (!uploadEnabled) {
  console.log('[sentry] API source-map upload disabled: upload credentials are not configured.');
  process.exit(0);
}

console.log(`[sentry] uploading API source maps for ${environment.APP_VERSION}`);
run('sentry-cli', ['sourcemaps', 'inject', 'dist']);
run('sentry-cli', [
  'sourcemaps',
  'upload',
  '--org',
  environment.SENTRY_ORG,
  '--project',
  environment.SENTRY_PROJECT,
  '--release',
  environment.APP_VERSION,
  'dist',
]);

for (const mapFile of mapFiles(distRoot)) rmSync(mapFile);
console.log('[sentry] API source maps uploaded and removed from the deploy artifact.');
