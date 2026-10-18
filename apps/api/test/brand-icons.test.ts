import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), icon: vi.fn() }));

vi.mock('../src/sessions/session.service.js', () => ({
  sessionService: {
    authenticate: mocks.authenticate,
    authenticateAndRenew: async (request: unknown) => ({
      session: await mocks.authenticate(request),
      renewedToken: null,
    }),
  },
}));

const { BrandIconService, isIconDomain } = await vi.importActual<
  typeof import('../src/features/facets/brand-icon.service.js')
>('../src/features/facets/brand-icon.service.js');

vi.mock('../src/features/facets/brand-icon.service.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/features/facets/brand-icon.service.js')
  >('../src/features/facets/brand-icon.service.js');
  return { ...actual, brandIconService: { icon: mocks.icon } };
});

const { entityIconDomains } = await import('../src/features/label-discovery/entity.js');
const { facetsRouter } = await import('../src/features/facets/facets.routes.js');
const { errorHandler } = await import('../src/middleware/errorHandler.js');
const { authenticationRequired } = await import('../src/errors/AppError.js');

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function upstream(status: number, contentType: string, body: Buffer = png) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': contentType }),
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
  };
}

describe('which domain a brand folder shows the logo of', () => {
  it('picks the domain the brand mails from most often', () => {
    const domains = entityIconDomains([
      { entity: 'netflix', senderEmail: 'info@mailer.netflix.com' },
      { entity: 'netflix', senderEmail: 'info@netflix.com' },
      { entity: 'netflix', senderEmail: 'x@netflix.net' },
      { entity: 'github', senderEmail: 'noreply@github.com' },
      { entity: null, senderEmail: 'someone@example.com' },
    ]);
    expect(domains.get('netflix')).toBe('netflix.com');
    expect(domains.get('github')).toBe('github.com');
    expect(domains.size).toBe(2);
  });
});

describe('fetching brand logos', () => {
  it('asks only the fixed logo service, never the sender site itself', async () => {
    const fetcher = vi.fn().mockResolvedValue(upstream(200, 'image/png'));
    const icon = await new BrandIconService(fetcher as never).icon('netflix.com');

    expect(icon?.contentType).toBe('image/png');
    const url = new URL(fetcher.mock.calls[0]?.[0] as string);
    expect(url.host).toBe('www.google.com');
    expect(url.searchParams.get('domain')).toBe('netflix.com');
  });

  it('refuses anything that is not a plain domain before fetching', async () => {
    const fetcher = vi.fn();
    const service = new BrandIconService(fetcher as never);
    for (const bad of ['localhost', '127.0.0.1', 'evil.com/path', 'a..b.com', 'x@y.com', '']) {
      expect(isIconDomain(bad)).toBe(false);
      await expect(service.icon(bad)).resolves.toBeNull();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('treats the service 404 as "no logo", so the folder keeps its own icon', async () => {
    const fetcher = vi.fn().mockResolvedValue(upstream(404, 'image/png'));
    await expect(
      new BrandIconService(fetcher as never).icon('unknown-brand.io'),
    ).resolves.toBeNull();
  });

  // Served from the API's own origin, an SVG opened directly could run script there.
  it('refuses SVG and anything that is not a raster image', async () => {
    for (const type of ['image/svg+xml', 'text/html', 'application/octet-stream']) {
      const fetcher = vi.fn().mockResolvedValue(upstream(200, type));
      await expect(new BrandIconService(fetcher as never).icon('brand.com')).resolves.toBeNull();
    }
  });

  it('fetches a logo once and serves it from memory after that', async () => {
    const fetcher = vi.fn().mockResolvedValue(upstream(200, 'image/png'));
    const service = new BrandIconService(fetcher as never);

    await Promise.all([service.icon('netflix.com'), service.icon('netflix.com')]);
    await service.icon('NETFLIX.com');

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not remember an outage as "no logo"', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue(upstream(200, 'image/png'));
    const service = new BrandIconService(fetcher as never);

    await expect(service.icon('netflix.com')).rejects.toThrow();
    await expect(service.icon('netflix.com')).resolves.not.toBeNull();
  });
});

const app = express();
app.use(cookieParser());
app.use('/api/facets', facetsRouter);
app.use(errorHandler);

describe('GET /api/facets/icons/:domain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({
      id: 'session-id',
      user: { id: 'user-id' },
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
  });

  it('requires a session', async () => {
    mocks.authenticate.mockRejectedValue(authenticationRequired());
    expect((await request(app).get('/api/facets/icons/netflix.com')).status).toBe(401);
  });

  /*
   * The page is www.mailmindai.tech and this is api.mailmindai.tech: same site, different origin.
   * Helmet's default resource policy is same-origin, which would make the browser refuse to draw
   * every logo.
   */
  it('serves the logo with a policy that lets the app draw it, cached privately', async () => {
    mocks.icon.mockResolvedValue({ contentType: 'image/png', body: png });

    const response = await request(app).get('/api/facets/icons/netflix.com');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-site');
    expect(response.headers['cache-control']).toContain('private');
  });

  it('answers 404 when there is no logo, and 400 for something that is not a domain', async () => {
    mocks.icon.mockResolvedValue(null);
    expect((await request(app).get('/api/facets/icons/unknown-brand.io')).status).toBe(404);
    expect((await request(app).get('/api/facets/icons/localhost')).status).toBe(400);
    expect(mocks.icon).toHaveBeenCalledTimes(1);
  });
});
