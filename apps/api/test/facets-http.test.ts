import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  startClassification: vi.fn(),
  startFiling: vi.fn(),
  settings: vi.fn(),
  setSettings: vi.fn(),
  plan: vi.fn(),
  view: vi.fn(),
  apply: vi.fn(),
}));

vi.mock('../src/sessions/session.service.js', () => ({
  sessionService: { authenticate: mocks.authenticate },
}));
vi.mock('../src/features/facets/facets.service.js', () => ({
  facetsService: mocks,
}));

import { AppError } from '../src/errors/AppError.js';
import { facetsRouter } from '../src/features/facets/facets.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use((request_, _response, next) => {
  request_.requestId = 'request-id';
  next();
});
app.use('/api/facets', facetsRouter);
app.use(errorHandler);

const RUN = '00000000-0000-4000-8000-000000000001';
const ORIGIN = 'http://localhost:5173';

/**
 * The facet pipeline had no HTTP surface at all: every service here was reachable only from a
 * `tsx` script, which is why the application could not be operated from a browser. These are the
 * routes that close that, and what they mostly have to get right is which of them are allowed to
 * spend a quota or touch a mailbox.
 */
describe('facet HTTP routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.authenticate.mockResolvedValue({
      id: 'session-id',
      user: { id: 'user-id', email: 'user@example.com', status: 'ACTIVE' },
    });
    const started = (kind: string) => ({
      runId: RUN,
      state: 'RUNNING',
      kind,
      startedAt: '2026-08-25T00:00:00.000Z',
      alreadyRunning: false,
    });
    mocks.startClassification.mockResolvedValue(started('FACET_CLASSIFICATION'));
    mocks.startFiling.mockResolvedValue(started('AUTOMATION_FILING'));
    mocks.settings.mockResolvedValue({ canonicalPivot: ['entity', 'intent'], minMessages: 5 });
    mocks.setSettings.mockResolvedValue({
      canonicalPivot: ['domain', 'intent', 'entity'],
      minMessages: 8,
    });
    mocks.plan.mockResolvedValue({ changes: [], orphaned: [], gmailLabelsToCreate: 0 });
    mocks.view.mockResolvedValue({ order: ['domain', 'intent'], nodes: [] });
    mocks.apply.mockResolvedValue({ rowsCreated: 2, gmailLabelsCreated: 1, orphaned: [] });
  });

  it('requires a session on every route', async () => {
    mocks.authenticate.mockRejectedValue(
      new AppError('AUTHENTICATION_REQUIRED', 'Authentication is required.', 401),
    );

    for (const [method, path] of [
      ['get', '/api/facets/pivot'],
      ['get', '/api/facets/pivot/plan'],
      ['get', '/api/facets/pivot/view'],
      ['post', '/api/facets/classify'],
      ['post', '/api/facets/file'],
      ['post', '/api/facets/pivot/apply'],
      ['put', '/api/facets/pivot'],
    ] as const) {
      const response = await request(app)[method](path).set('Origin', ORIGIN);
      expect(response.status).toBe(401);
    }
  });

  // Classifying a mailbox is thousands of paced Gemini calls, and filing is one Gmail call per
  // message. Neither fits inside a browser request, so both accept and hand back a run id.
  it('accepts classification and filing with 202 and a run id to poll', async () => {
    const classify = await request(app).post('/api/facets/classify').set('Origin', ORIGIN);
    expect(classify.status).toBe(202);
    expect(classify.body).toMatchObject({ runId: RUN, kind: 'FACET_CLASSIFICATION' });

    const file = await request(app).post('/api/facets/file').set('Origin', ORIGIN);
    expect(file.status).toBe(202);
    expect(file.body).toMatchObject({ runId: RUN, kind: 'AUTOMATION_FILING' });
  });

  // Everything that spends a quota or writes to a mailbox is origin-checked. A read is not.
  it('refuses a mutation from an untrusted origin', async () => {
    for (const path of ['/api/facets/classify', '/api/facets/file', '/api/facets/pivot/apply']) {
      const denied = await request(app).post(path).set('Origin', 'https://evil.example');
      expect(denied.status).toBe(403);
    }
    const deniedPut = await request(app)
      .put('/api/facets/pivot')
      .set('Origin', 'https://evil.example')
      .send({ canonicalPivot: ['entity'] });
    expect(deniedPut.status).toBe(403);

    expect(mocks.startClassification).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.setSettings).not.toHaveBeenCalled();
  });

  it('serves the pivot settings without caching them', async () => {
    const response = await request(app).get('/api/facets/pivot');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toMatchObject({ canonicalPivot: ['entity', 'intent'], minMessages: 5 });
  });

  // A pivot is an ORDER of distinct facets. Repeating one is not a deeper tree, it is the same
  // level twice, and a name outside the three is not a facet at all.
  it('refuses a pivot that repeats a facet or invents one', async () => {
    for (const canonicalPivot of [['entity', 'entity'], ['sender'], []]) {
      const response = await request(app)
        .put('/api/facets/pivot')
        .set('Origin', ORIGIN)
        .send({ canonicalPivot });
      expect(response.status).toBe(400);
    }
    expect(mocks.setSettings).not.toHaveBeenCalled();
  });

  it('sets a new canonical ordering and answers with what it stored', async () => {
    const response = await request(app)
      .put('/api/facets/pivot')
      .set('Origin', ORIGIN)
      .send({ canonicalPivot: ['domain', 'intent', 'entity'], minMessages: 8 });

    expect(response.status).toBe(200);
    expect(mocks.setSettings).toHaveBeenCalledWith('user-id', ['domain', 'intent', 'entity'], 8);
    expect(response.body).toMatchObject({ canonicalPivot: ['domain', 'intent', 'entity'] });
  });

  // The preview the Pivot screen renders before anything touches Gmail.
  it('plans without applying', async () => {
    const response = await request(app).get('/api/facets/pivot/plan');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  /**
   * Any ordering at all, materialised or not — the same facet rows arranged differently, with no
   * Gmail call and no model call. It is a query string so an ordering can be shared as a link.
   */
  it('reads an alternate ordering off the query string', async () => {
    const response = await request(app).get(
      '/api/facets/pivot/view?order=domain,intent,entity&minMessages=3',
    );

    expect(response.status).toBe(200);
    expect(mocks.view).toHaveBeenCalledWith('user-id', ['domain', 'intent', 'entity'], 3);
  });

  it('falls back to the default ordering when the query names none', async () => {
    const response = await request(app).get('/api/facets/pivot/view');

    expect(response.status).toBe(200);
    expect(mocks.view).toHaveBeenCalledWith('user-id', undefined, undefined);
  });

  it('refuses an ordering the query string invented', async () => {
    const response = await request(app).get('/api/facets/pivot/view?order=entity,sender');

    expect(response.status).toBe(400);
    expect(mocks.view).not.toHaveBeenCalled();
  });

  /**
   * Applying is bounded by the number of folders, not the number of messages, so it answers
   * inline. It never deletes: folders matching no current combination come back in `orphaned`
   * for a person to decide about, because deleting a Gmail label never unlabels its mail.
   */
  it('applies the canonical pivot inline and reports what it left alone', async () => {
    mocks.apply.mockResolvedValue({
      rowsCreated: 2,
      gmailLabelsCreated: 1,
      orphaned: [{ id: 'row-gone', fullPath: 'MailMind/Old', gmailLabelId: 'Label_old' }],
    });

    const response = await request(app).post('/api/facets/pivot/apply').set('Origin', ORIGIN);

    expect(response.status).toBe(200);
    expect(response.body.orphaned).toHaveLength(1);
  });
});
