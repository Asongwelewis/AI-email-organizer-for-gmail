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
  facetCount: vi.fn(),
  facetFindFirst: vi.fn(),
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
    favorite_folders: {
      findMany: mocks.findMany,
      findUnique: mocks.findUnique,
      count: mocks.count,
      upsert: mocks.upsert,
      deleteMany: mocks.deleteMany,
    },
    message_facets: { count: mocks.facetCount, findFirst: mocks.facetFindFirst },
    connected_google_accounts: {
      findFirst: async () => ({ id: 'account-1', user_id: 'user-1' }),
    },
  },
}));

const { parseFacetKey } = await import('../src/features/label-discovery/pivot.js');
const { favoritesRouter } = await import('../src/features/favorites/favorites.routes.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const { authenticationRequired } = await import('../src/errors/AppError.js');

const ORIGIN = 'http://localhost:5173';
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/favorites', favoritesRouter);
app.use(errorHandler);

const row = (facetKey: string, order = ['entity', 'intent']) => ({
  id: `fav-${facetKey}`,
  connected_google_account_id: 'account-1',
  facet_key: facetKey,
  pivot_order: order,
  created_at: new Date('2026-10-18T10:00:00.000Z'),
});

describe('reading a folder key back into its parts', () => {
  it('accepts a key this app could have built', () => {
    expect(parseFacetKey('entity=netflix|intent=payment-failed')).toEqual([
      { facet: 'entity', value: 'netflix', name: 'Netflix' },
      { facet: 'intent', value: 'payment-failed', name: 'Payment failed' },
    ]);
  });

  it.each([
    'nothing',
    'colour=red',
    'entity=netflix|entity=hulu',
    'entity=',
    'entity=a|domain=b|intent=c|entity=d',
  ])('refuses %s', (key) => {
    expect(parseFacetKey(key)).toBeNull();
  });
});

describe('/api/favorites', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({
      id: 'session-id',
      user: { id: 'user-1' },
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    mocks.findMany.mockResolvedValue([]);
    mocks.findUnique.mockResolvedValue(null);
    mocks.count.mockResolvedValue(0);
    mocks.facetCount.mockResolvedValueOnce(12).mockResolvedValueOnce(3);
    mocks.facetFindFirst.mockResolvedValue({
      message: {
        internal_date: new Date('2026-10-18T09:00:00.000Z'),
        sender_email: 'info@mailer.netflix.com',
      },
    });
  });

  it('requires a session', async () => {
    mocks.authenticate.mockRejectedValue(authenticationRequired());
    expect((await request(app).get('/api/favorites')).status).toBe(401);
  });

  it('stars a folder and answers with its live counts and logo domain', async () => {
    mocks.upsert.mockResolvedValue(row('entity=netflix|intent=payment-failed'));

    const response = await request(app)
      .post('/api/favorites')
      .set('Origin', ORIGIN)
      .send({ facetKey: 'entity=netflix|intent=payment-failed', order: ['entity', 'intent'] });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      facetKey: 'entity=netflix|intent=payment-failed',
      name: 'Payment failed',
      path: 'Netflix/Payment failed',
      messageCount: 12,
      unreadCount: 3,
      iconDomain: 'netflix.com',
    });
  });

  // A key has to be one the arrangement could produce, or it would open nowhere.
  it('refuses a key that does not belong to the arrangement it claims', async () => {
    const response = await request(app)
      .post('/api/favorites')
      .set('Origin', ORIGIN)
      .send({ facetKey: 'intent=promotional', order: ['entity', 'intent'] });

    expect(response.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('refuses a new favourite past the ceiling, but not re-starring an existing one', async () => {
    mocks.count.mockResolvedValue(100);
    const refused = await request(app)
      .post('/api/favorites')
      .set('Origin', ORIGIN)
      .send({ facetKey: 'entity=netflix', order: ['entity', 'intent'] });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('FAVORITES_LIMIT_REACHED');

    mocks.findUnique.mockResolvedValue(row('entity=netflix'));
    mocks.upsert.mockResolvedValue(row('entity=netflix'));
    const again = await request(app)
      .post('/api/favorites')
      .set('Origin', ORIGIN)
      .send({ facetKey: 'entity=netflix', order: ['entity', 'intent'] });
    expect(again.status).toBe(201);
  });

  it('refuses a change from an untrusted origin', async () => {
    const response = await request(app)
      .post('/api/favorites')
      .set('Origin', 'https://evil.example')
      .send({ facetKey: 'entity=netflix', order: ['entity'] });
    expect(response.status).toBe(403);
  });

  it('unstars by folder key, scoped to the caller', async () => {
    mocks.deleteMany.mockResolvedValue({ count: 1 });

    const response = await request(app)
      .delete(`/api/favorites/${encodeURIComponent('entity=netflix|intent=payment-failed')}`)
      .set('Origin', ORIGIN);

    expect(response.status).toBe(204);
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: {
        connected_google_account_id: 'account-1',
        facet_key: 'entity=netflix|intent=payment-failed',
      },
    });
  });

  it('lists favourites and silently drops one that is no longer a folder', async () => {
    mocks.findMany.mockResolvedValue([row('entity=netflix'), row('colour=red')]);
    mocks.facetCount.mockReset().mockResolvedValue(4);

    const response = await request(app).get('/api/favorites');

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].facetKey).toBe('entity=netflix');
  });

  it('hands the Inbox just the starred keys', async () => {
    mocks.findMany.mockResolvedValue([{ facet_key: 'entity=netflix' }]);
    const response = await request(app).get('/api/favorites/keys');
    expect(response.body).toEqual({ keys: ['entity=netflix'] });
  });
});
