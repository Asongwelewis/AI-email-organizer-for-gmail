import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rootPackagePath = fileURLToPath(new URL('../package.json', import.meta.url));
const rootPackage = JSON.parse(readFileSync(rootPackagePath, 'utf8'));

function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function resolveAppVersion(environment = process.env) {
  const explicitVersions = [
    clean(environment.APP_VERSION),
    clean(environment.VITE_APP_VERSION),
    clean(environment.SENTRY_RELEASE),
  ].filter(Boolean);
  const uniqueVersions = [...new Set(explicitVersions)];

  if (uniqueVersions.length > 1) {
    throw new Error(
      'APP_VERSION, VITE_APP_VERSION, and SENTRY_RELEASE must use the same release value.',
    );
  }

  if (uniqueVersions[0]) return uniqueVersions[0];

  const commit = clean(
    environment.VERCEL_GIT_COMMIT_SHA ?? environment.RENDER_GIT_COMMIT ?? environment.GITHUB_SHA,
  );

  return commit ? `mailmind@${commit}` : `mailmind@${rootPackage.version}`;
}

export function appVersionEnvironment(environment = process.env) {
  const release = resolveAppVersion(environment);
  return {
    ...environment,
    APP_VERSION: release,
    VITE_APP_VERSION: release,
    SENTRY_RELEASE: release,
  };
}
