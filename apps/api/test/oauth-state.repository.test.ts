import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
}));

vi.mock('../src/database/prisma.js', () => ({
  prisma: { oauth_states: database },
}));

import { OAuthStateRepository } from '../src/repositories/oauth-state.repository.js';

const state = (overrides: Record<string, unknown> = {}) => ({
  id: 'state-id',
  state_hash: 'state-hash',
  purpose: 'LOGIN',
  expires_at: new Date(Date.now() + 60_000),
  used_at: null,
  ...overrides,
});

describe('OAuthStateRepository', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('atomically consumes a valid state', async () => {
    database.findUnique.mockResolvedValue(state());
    database.updateMany.mockResolvedValue({ count: 1 });
    await expect(
      new OAuthStateRepository().consume('state-hash', ['LOGIN']),
    ).resolves.toMatchObject({
      id: 'state-id',
    });
    expect(database.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'state-id', used_at: null }),
        data: { used_at: expect.any(Date) },
      }),
    );
  });

  it.each([
    ['missing state', null, ['LOGIN'], 'AUTH_OAUTH_STATE_INVALID'],
    ['wrong purpose', state({ purpose: 'CONNECT_GMAIL' }), ['LOGIN'], 'AUTH_OAUTH_STATE_INVALID'],
    ['used state', state({ used_at: new Date() }), ['LOGIN'], 'AUTH_OAUTH_STATE_USED'],
    ['expired state', state({ expires_at: new Date(0) }), ['LOGIN'], 'AUTH_OAUTH_STATE_EXPIRED'],
  ])('rejects %s', async (_description, record, purposes, code) => {
    database.findUnique.mockResolvedValue(record);
    await expect(
      new OAuthStateRepository().consume('state-hash', purposes as ['LOGIN']),
    ).rejects.toMatchObject({ code });
    expect(database.updateMany).not.toHaveBeenCalled();
  });

  it('allows only one winner when callbacks race', async () => {
    database.findUnique.mockResolvedValue(state());
    database.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const repository = new OAuthStateRepository();
    const results = await Promise.allSettled([
      repository.consume('state-hash', ['LOGIN']),
      repository.consume('state-hash', ['LOGIN']),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'AUTH_OAUTH_STATE_USED' } });
  });
});
