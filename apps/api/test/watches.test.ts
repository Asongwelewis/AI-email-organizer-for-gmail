import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  count: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
}));

vi.mock('../src/sessions/session.service.js', () => ({
  sessionService: {
    authenticate: mocks.authenticate,
    authenticateAndRenew: async (request: unknown) => ({
      session: await mocks.authenticate(request),
      renewedToken: null,
    }),
  },
}));
vi.mock('../src/database/prisma.js', () => ({
  prisma: {
    watched_folders: {
      findMany: mocks.findMany,
      findUnique: mocks.findUnique,
      count: mocks.count,
      upsert: mocks.upsert,
      deleteMany: mocks.deleteMany,
    },
    connected_google_accounts: {
      findFirst: async () => ({ id: 'account-1', user_id: 'user-1' }),
    },
  },
}));

const { env } = await import('../src/config/env.js');
const { describeWatch, knownFacets, watchCovers } =
  await import('../src/features/watches/watch-match.js');
const { WatchesService, MAX_WATCHES } = await import('../src/features/watches/watches.service.js');
const { watchesRouter } = await import('../src/features/watches/watches.routes.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const { authenticationRequired } = await import('../src/errors/AppError.js');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.count.mockResolvedValue(0);
  mocks.findUnique.mockResolvedValue(null);
  mocks.upsert.mockResolvedValue({});
  mocks.deleteMany.mockResolvedValue({ count: 1 });
});

describe('what a watch covers', () => {
  it('is the same watch whichever arrangement it was set from', () => {
    const fromEntity = describeWatch('entity=applyboard|intent=offer');
    const fromIntent = describeWatch('intent=offer|entity=applyboard');

    expect(fromEntity?.facetKey).toBe('entity=applyboard|intent=offer');
    expect(fromIntent?.facetKey).toBe('entity=applyboard|intent=offer');
    // Named the way the person saw it.
    expect(fromIntent?.name).toBe('Offer › Applyboard');
  });

  it('refuses a key no folder could have', () => {
    expect(describeWatch('')).toBeNull();
    expect(describeWatch('colour=blue')).toBeNull();
    expect(describeWatch('entity=a|entity=b')).toBeNull();
  });

  it('covers mail carrying every value it names, and nothing undecided', () => {
    const watch = describeWatch('entity=applyboard|intent=offer')!;

    expect(watchCovers(watch, { entity: 'applyboard', domain: 'education', intent: 'offer' })).toBe(
      true,
    );
    expect(
      watchCovers(watch, { entity: 'applyboard', domain: 'education', intent: 'promotional' }),
    ).toBe(false);
    // Not classified yet: the intent is unknown, so it is not a match until it is decided.
    expect(watchCovers(watch, knownFacets('no-reply@applyboard.com', null))).toBe(false);
  });

  it('knows a brand from the sender address before anything is classified', () => {
    const watch = describeWatch('entity=applyboard')!;

    expect(watchCovers(watch, knownFacets('no-reply@mail.applyboard.com', null))).toBe(true);
    expect(watchCovers(watch, knownFacets('news@shop.example', null))).toBe(false);
  });
});

describe('watching a folder', () => {
  it('stores the canonical key', async () => {
    await expect(
      new WatchesService().add('user-1', 'intent=offer|entity=applyboard'),
    ).resolves.toBe('entity=applyboard|intent=offer');

    expect(mocks.upsert.mock.calls[0]![0].create).toEqual({
      connected_google_account_id: 'account-1',
      facet_key: 'entity=applyboard|intent=offer',
    });
  });

  it('stops at the ceiling, but re-watching one already watched is fine', async () => {
    mocks.count.mockResolvedValue(MAX_WATCHES);
    await expect(new WatchesService().add('user-1', 'entity=applyboard')).rejects.toMatchObject({
      code: 'WATCHES_LIMIT_REACHED',
      statusCode: 409,
    });

    mocks.findUnique.mockResolvedValue({ id: 'w-1' });
    await expect(new WatchesService().add('user-1', 'entity=applyboard')).resolves.toBe(
      'entity=applyboard',
    );
  });

  it('unwatches by the canonical key, whatever order it is named in', async () => {
    await new WatchesService().remove('user-1', 'intent=offer|entity=applyboard');

    expect(mocks.deleteMany.mock.calls[0]![0].where).toEqual({
      connected_google_account_id: 'account-1',
      facet_key: 'entity=applyboard|intent=offer',
    });
  });

  it('leaves out a stored key that stopped being a folder', async () => {
    mocks.findMany.mockResolvedValue([{ facet_key: 'entity=applyboard' }, { facet_key: 'x=y' }]);

    const watches = await new WatchesService().forAccount('account-1');

    expect(watches.map((watch) => watch.facetKey)).toEqual(['entity=applyboard']);
  });
});

describe('/api/watches', () => {
  const app = () => {
    const server = express();
    server.use(express.json());
    server.use(cookieParser());
    server.use('/api/watches', watchesRouter);
    server.use(errorHandler);
    return server;
  };
  const origin = env.WEB_APP_URL;

  beforeEach(() => {
    mocks.authenticate.mockResolvedValue({
      user: { id: 'user-1', email: 'owner@example.com' },
      session: { id: 'session-1' },
    });
  });

  it('lists the keys, and nothing without a session', async () => {
    mocks.findMany.mockResolvedValue([{ facet_key: 'entity=applyboard' }]);

    const listed = await request(app()).get('/api/watches').set('Cookie', 'mailmind_session=x');
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ keys: ['entity=applyboard'] });

    mocks.authenticate.mockRejectedValue(authenticationRequired());
    const anonymous = await request(app()).get('/api/watches');
    expect(anonymous.status).toBe(401);
  });

  it('watches from a trusted origin only', async () => {
    const trusted = await request(app())
      .post('/api/watches')
      .set('Origin', origin)
      .set('Cookie', 'mailmind_session=x')
      .send({ facetKey: 'entity=applyboard' });
    expect(trusted.status).toBe(201);
    expect(trusted.body).toEqual({ facetKey: 'entity=applyboard' });

    const untrusted = await request(app())
      .post('/api/watches')
      .set('Origin', 'https://evil.example')
      .set('Cookie', 'mailmind_session=x')
      .send({ facetKey: 'entity=applyboard' });
    expect(untrusted.status).toBe(403);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
  });

  it('refuses something that is not a folder', async () => {
    const response = await request(app())
      .post('/api/watches')
      .set('Origin', origin)
      .set('Cookie', 'mailmind_session=x')
      .send({ facetKey: 'colour=blue' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('WATCH_VALIDATION_FAILED');
  });

  it('unwatches', async () => {
    const response = await request(app())
      .delete(`/api/watches/${encodeURIComponent('entity=applyboard')}`)
      .set('Origin', origin)
      .set('Cookie', 'mailmind_session=x');

    expect(response.status).toBe(204);
    expect(mocks.deleteMany).toHaveBeenCalledTimes(1);
  });
});
