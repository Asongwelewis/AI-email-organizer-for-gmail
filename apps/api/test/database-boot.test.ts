import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn(), warn: vi.fn() }));

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
  safeErrorDetails: () => ({}),
}));

const { pendingMigrations, shippedMigrations } = await import('../src/database/migrations.js');
const { prisma, retryTransientRead, startDatabaseHeartbeat, stopDatabaseHeartbeat } =
  await import('../src/database/prisma.js');

/**
 * The boot-time check replaced `prisma migrate deploy` in front of every start. It is only worth
 * having if "nothing pending" is decided correctly — a false "current" is the 28 Aug 2026 outage
 * again, a migration shipped and never applied.
 */
describe('which migrations still have to run', () => {
  it('reads the migrations this build ships, ignoring anything without a migration.sql', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mailmind-migrations-'));
    for (const name of ['20260101000000_first', '20260102000000_second']) {
      mkdirSync(join(directory, name));
      writeFileSync(join(directory, name, 'migration.sql'), 'select 1;');
    }
    mkdirSync(join(directory, 'not_a_migration'));
    writeFileSync(join(directory, 'migration_lock.toml'), '');

    expect(shippedMigrations(directory)).toEqual(['20260101000000_first', '20260102000000_second']);
  });

  it('finds the real migrations directory from wherever the server runs', () => {
    expect(shippedMigrations().length).toBeGreaterThan(0);
  });

  it('treats a migration the database has not finished as pending', () => {
    const shipped = ['a', 'b', 'c'];
    expect(pendingMigrations(shipped, new Set(['a', 'b', 'c']))).toEqual([]);
    expect(pendingMigrations(shipped, new Set(['a']))).toEqual(['b', 'c']);
  });

  it('treats a database with no bookkeeping table as needing everything', () => {
    expect(pendingMigrations(['a', 'b'], null)).toEqual(['a', 'b']);
  });
});

describe('the database heartbeat', () => {
  afterEach(() => {
    stopDatabaseHeartbeat();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('touches the database on its interval and survives a failed beat', async () => {
    vi.useFakeTimers();
    const spy = vi
      .spyOn(prisma, '$queryRaw')
      .mockRejectedValueOnce(new Error('connection reset') as never)
      .mockResolvedValue([] as never);

    startDatabaseHeartbeat(60);
    startDatabaseHeartbeat(60); // a second start must not double the beat
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorType: 'Error' }),
      'database heartbeat failed',
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does nothing when it is turned off', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(prisma, '$queryRaw').mockResolvedValue([] as never);
    startDatabaseHeartbeat(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(spy).not.toHaveBeenCalled();
  });
});

/*
 * The pooler can close a connection the pool still holds, and the next query to draw it fails. A
 * read changes nothing, so it is asked once more on a fresh connection; a write never is, because it
 * may already have landed.
 */
describe('a read whose connection dropped', () => {
  const dropped = () =>
    Object.assign(new Error('Server has closed the connection.'), { code: 'P1017' });

  it('is asked once more and answers', async () => {
    const run = vi.fn().mockRejectedValueOnce(dropped()).mockResolvedValueOnce(['row']);
    await expect(retryTransientRead('findMany', run, 0)).resolves.toEqual(['row']);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('gives up after the second attempt', async () => {
    const run = vi.fn().mockRejectedValue(dropped());
    await expect(retryTransientRead('count', run, 0)).rejects.toMatchObject({ code: 'P1017' });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('never repeats a write', async () => {
    const run = vi.fn().mockRejectedValue(dropped());
    await expect(retryTransientRead('create', run, 0)).rejects.toMatchObject({ code: 'P1017' });
    expect(run).toHaveBeenCalledOnce();
  });

  // A missing table is a fact about the schema, not about the connection; asking again changes nothing.
  it('does not retry an error that is about the query rather than the connection', async () => {
    const run = vi.fn().mockRejectedValue(Object.assign(new Error('no table'), { code: 'P2021' }));
    await expect(retryTransientRead('findMany', run, 0)).rejects.toMatchObject({ code: 'P2021' });
    expect(run).toHaveBeenCalledOnce();
  });
});
