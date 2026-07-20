import { beforeEach, describe, expect, it, vi } from 'vitest';

const repository = vi.hoisted(() => ({
  create: vi.fn(),
  findByTokenHash: vi.fn(),
  touch: vi.fn(),
  revoke: vi.fn(),
  revokeAllForUser: vi.fn(),
  rotate: vi.fn(),
}));

vi.mock('../src/repositories/session.repository.js', () => ({ sessionRepository: repository }));

import { sha256 } from '../src/security/hashing.service.js';
import { SessionService } from '../src/sessions/session.service.js';

const activeRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'session-id',
  user_id: 'user-id',
  session_token_hash: sha256('raw-session-token'),
  expires_at: new Date(Date.now() + 60_000),
  revoked_at: null,
  last_used_at: new Date(0),
  users: {
    id: 'user-id',
    email: 'user@example.com',
    display_name: null,
    avatar_url: null,
    status: 'ACTIVE',
  },
  ...overrides,
});

const requestWithToken = () =>
  ({ cookies: { mailmind_session: 'raw-session-token' }, get: vi.fn(), ip: '127.0.0.1' }) as never;

describe('SessionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the raw token only to the cookie layer and persists only its hash', async () => {
    repository.create.mockImplementation(async (data) => activeRecord(data));
    const request = { get: vi.fn().mockReturnValue('test-agent'), ip: '127.0.0.1' } as never;
    const result = await new SessionService().create('user-id', request);
    const stored = repository.create.mock.calls[0]?.[0] as { session_token_hash: string };
    expect(stored.session_token_hash).toBe(sha256(result.rawToken));
    expect(stored.session_token_hash).not.toBe(result.rawToken);
    expect(JSON.stringify(result.session)).not.toContain(result.rawToken);
  });

  it('authenticates a valid session and throttles its touch', async () => {
    repository.findByTokenHash.mockResolvedValue(activeRecord());
    const result = await new SessionService().authenticate(requestWithToken());
    expect(result.user.id).toBe('user-id');
    expect(repository.findByTokenHash).toHaveBeenCalledWith(sha256('raw-session-token'));
    expect(repository.touch).toHaveBeenCalledOnce();
  });

  it('rejects missing, unknown, expired, and revoked sessions', async () => {
    const service = new SessionService();
    await expect(service.authenticate({ cookies: {} } as never)).rejects.toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
    });
    repository.findByTokenHash.mockResolvedValueOnce(null);
    await expect(service.authenticate(requestWithToken())).rejects.toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
    });
    repository.findByTokenHash.mockResolvedValueOnce(activeRecord({ expires_at: new Date(0) }));
    await expect(service.authenticate(requestWithToken())).rejects.toMatchObject({
      code: 'AUTH_SESSION_EXPIRED',
    });
    repository.findByTokenHash.mockResolvedValueOnce(activeRecord({ revoked_at: new Date() }));
    await expect(service.authenticate(requestWithToken())).rejects.toMatchObject({
      code: 'AUTH_SESSION_REVOKED',
    });
  });

  it.each(['SUSPENDED', 'DELETED'] as const)('rejects a %s user', async (status) => {
    repository.findByTokenHash.mockResolvedValue(
      activeRecord({ users: { ...activeRecord().users, status } }),
    );
    await expect(new SessionService().authenticate(requestWithToken())).rejects.toMatchObject({
      code: status === 'SUSPENDED' ? 'AUTH_USER_SUSPENDED' : 'AUTH_USER_DELETED',
    });
  });

  it('allows only one winner when concurrent rotation loses its conditional update', async () => {
    repository.findByTokenHash.mockResolvedValue(activeRecord());
    repository.rotate.mockResolvedValueOnce(activeRecord()).mockResolvedValueOnce(null);
    const service = new SessionService();
    const results = await Promise.allSettled([
      service.rotate(requestWithToken()),
      service.rotate(requestWithToken()),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });
});
