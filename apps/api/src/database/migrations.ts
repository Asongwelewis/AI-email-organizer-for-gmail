import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger } from '../config/logger.js';
import { prisma } from './prisma.js';

/**
 * Applies pending migrations during boot, and costs one query when there are none.
 *
 * The start command used to run `prisma migrate deploy` in front of the server on every start.
 * That is the right guarantee — on 28 Aug 2026 a migration reached production without running,
 * because the pre-deploy hook never fires on this plan — but on the free plan every wake-up is a
 * start, so a person tapping the app paid for a CLI process, its engine and a second cold database
 * connection before the server even listened. Here the check rides the connection the server
 * already opened, and the CLI only runs when there is something for it to do.
 *
 * It lives in the server rather than in render.yaml so the guarantee holds whatever start command
 * the live service is actually configured with.
 */

// `src/database` in development and `dist/database` in production are both two levels under the
// workspace, which is where `prisma/` lives.
const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrationsDirectory = resolve(apiRoot, 'prisma', 'migrations');
const schemaPath = resolve(apiRoot, 'prisma', 'schema.prisma');

/** The migrations this build ships, by directory name. */
export function shippedMigrations(directory = migrationsDirectory): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(resolve(directory, entry.name, 'migration.sql')),
    )
    .map((entry) => entry.name)
    .sort();
}

/**
 * Names this database has finished applying. Null when the bookkeeping table does not exist yet,
 * which is a brand-new database: everything is pending.
 */
async function appliedMigrations(): Promise<Set<string> | null> {
  try {
    const rows = await prisma.$queryRaw<Array<{ migration_name: string }>>`
      select migration_name
      from _prisma_migrations
      where finished_at is not null and rolled_back_at is null
    `;
    return new Set(rows.map((row) => row.migration_name));
  } catch (error) {
    // 42P01: undefined_table. Anything else is a real problem and should stop the boot.
    if ((error as { meta?: { code?: string } }).meta?.code === '42P01') return null;
    throw error;
  }
}

/**
 * What still has to run. A migration that started and failed has no `finished_at`, so it counts
 * as pending — and `migrate deploy` then refuses loudly, which is exactly the right outcome.
 */
export function pendingMigrations(shipped: string[], applied: Set<string> | null): string[] {
  if (!applied) return shipped;
  return shipped.filter((name) => !applied.has(name));
}

function runMigrateDeploy(): void {
  const require = createRequire(import.meta.url);
  const cli = resolve(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');
  const result = spawnSync(process.execPath, [cli, 'migrate', 'deploy', '--schema', schemaPath], {
    cwd: apiRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy exited with status ${result.status ?? 'unknown'}`);
  }
}

export type SchemaStatus = 'current' | 'behind' | 'unknown';

/**
 * Whether every migration this build ships has been applied. `unknown` when the build carries no
 * migrations to compare against — the container image — which is not a reason to call it behind.
 *
 * This is what `/ready` reports, so a migration that did not reach the database shows up from
 * outside within minutes instead of as 500s from the first screen that touches its tables.
 */
export async function schemaStatus(): Promise<SchemaStatus> {
  if (!existsSync(migrationsDirectory)) return 'unknown';
  const pending = pendingMigrations(shippedMigrations(), await appliedMigrations());
  return pending.length === 0 ? 'current' : 'behind';
}

export async function migrateIfPending(): Promise<void> {
  if (!existsSync(migrationsDirectory)) {
    // The container image ships `dist` alone and migrates as a separate step; Render ships the
    // whole repository, so there this branch never runs.
    logger.warn('no migrations directory beside this build; skipping the boot-time check');
    return;
  }
  const pending = pendingMigrations(shippedMigrations(), await appliedMigrations());
  if (pending.length === 0) {
    logger.info('database schema is current');
    return;
  }
  logger.info({ pending: pending.length }, 'applying pending database migrations');
  runMigrateDeploy();
  logger.info({ applied: pending.length }, 'database migrations applied');
}
