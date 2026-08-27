import { spawnSync } from 'node:child_process';

import { appVersionEnvironment } from './app-version.mjs';

const [command, ...args] = process.argv.slice(2);

if (!command) {
  throw new Error('Usage: node scripts/with-app-version.mjs <command> [...args]');
}

const environment = appVersionEnvironment();
console.log(`[sentry] shared release: ${environment.APP_VERSION}`);

const result = spawnSync(command, args, {
  cwd: process.cwd(),
  env: environment,
  shell: process.platform === 'win32',
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
