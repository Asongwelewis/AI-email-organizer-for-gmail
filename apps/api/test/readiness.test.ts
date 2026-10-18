import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ schemaStatus: vi.fn() }));

vi.mock('../src/database/migrations.js', () => ({ schemaStatus: mocks.schemaStatus }));

const { HealthService } = await import('../src/services/healthService.js');

/*
 * `/ready` answers whether this build's migrations reached the database, not just whether the
 * database answers. A migration that never applied used to surface only as 500s from the first
 * screen that touched its tables; now the readiness probe — and the wake workflow that calls it
 * every ten minutes — says so first.
 */
describe('readiness', () => {
  beforeEach(() => vi.resetAllMocks());

  it('is ready when the database answers and every shipped migration is applied', async () => {
    mocks.schemaStatus.mockResolvedValue('current');
    await expect(new HealthService().getReadiness()).resolves.toMatchObject({
      status: 'ready',
      dependencies: { database: 'up', schema: 'current' },
    });
  });

  it('is not ready while a shipped migration is missing', async () => {
    mocks.schemaStatus.mockResolvedValue('behind');
    await expect(new HealthService().getReadiness()).resolves.toMatchObject({
      status: 'unavailable',
      dependencies: { database: 'up', schema: 'behind' },
    });
  });

  // The container image ships no migrations to compare against; that is not the same as behind.
  it('stays ready when there is nothing to compare against', async () => {
    mocks.schemaStatus.mockResolvedValue('unknown');
    await expect(new HealthService().getReadiness()).resolves.toMatchObject({ status: 'ready' });
  });

  it('is not ready when the database does not answer', async () => {
    mocks.schemaStatus.mockRejectedValue(new Error('connection refused'));
    await expect(new HealthService().getReadiness()).resolves.toMatchObject({
      status: 'unavailable',
      dependencies: { database: 'down', schema: 'unknown' },
    });
  });
});
