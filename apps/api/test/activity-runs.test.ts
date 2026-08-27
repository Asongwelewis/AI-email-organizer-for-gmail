import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  captureApiException: vi.fn(),
  activeAccountForUser: vi.fn(),
  runningRun: vi.fn(),
  reclaimAbandoned: vi.fn(),
  create: vi.fn(),
  reportProgress: vi.fn(),
  finish: vi.fn(),
  attachFeatureRun: vi.fn(),
  recent: vi.fn(),
  runForAccount: vi.fn(),
}));

vi.mock('../src/config/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  safeErrorDetails: () => ({}),
}));
vi.mock('../src/observability/sentry.js', () => ({
  captureApiException: mocks.captureApiException,
}));
vi.mock('../src/sessions/session.service.js', () => ({
  sessionService: { authenticate: mocks.authenticate },
}));
vi.mock('../src/middleware/rateLimiters.js', () => {
  const passthrough = (_request: unknown, _response: unknown, next: () => void) => next();
  return { activityPollLimiter: passthrough };
});
// The HTTP routes reach the module singleton, so the repository is what has to be replaced there.
vi.mock('../src/features/activity/activity.repository.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/features/activity/activity.repository.js')
  >('../src/features/activity/activity.repository.js');
  return { ...actual, activityRepository: mocks };
});

import { AppError } from '../src/errors/AppError.js';
import { activityRouter } from '../src/features/activity/activity.routes.js';
import type { ActivityRepository } from '../src/features/activity/activity.repository.js';
import { ActivityService, describeFailure } from '../src/features/activity/activity.service.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';
const RUN_ID = '00000000-0000-4000-8000-000000000002';

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    connected_google_account_id: ACCOUNT_ID,
    kind: 'AUTOMATION_FILING',
    state: 'RUNNING',
    trigger: 'MANUAL',
    processed_count: 0,
    total_count: null,
    counts: {},
    stop_reason: null,
    error_code: null,
    error_message: null,
    feature_run_id: null,
    expires_at: new Date('2026-08-20T00:05:00.000Z'),
    started_at: new Date('2026-08-20T00:00:00.000Z'),
    finished_at: null,
    created_at: new Date('2026-08-20T00:00:00.000Z'),
    updated_at: new Date('2026-08-20T00:00:00.000Z'),
    ...overrides,
  };
}

function service() {
  return new ActivityService(mocks as unknown as ActivityRepository);
}

describe('activity runs', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.activeAccountForUser.mockResolvedValue({ id: ACCOUNT_ID });
    mocks.reclaimAbandoned.mockResolvedValue(0);
    mocks.runningRun.mockResolvedValue(null);
    mocks.create.mockResolvedValue(run());
    mocks.reportProgress.mockResolvedValue(undefined);
    mocks.finish.mockResolvedValue(undefined);
  });

  it('starts a run and reports it as running', async () => {
    const started = await service().start({ accountId: ACCOUNT_ID, kind: 'AUTOMATION_FILING' });

    expect(started).toMatchObject({ runId: RUN_ID, state: 'RUNNING', alreadyRunning: false });
    expect(mocks.reclaimAbandoned).toHaveBeenCalledWith(ACCOUNT_ID, 'AUTOMATION_FILING');
  });

  it('joins the run already in flight instead of starting a second one', async () => {
    mocks.runningRun.mockResolvedValue(run());

    const started = await service().start({ accountId: ACCOUNT_ID, kind: 'AUTOMATION_FILING' });

    expect(started).toMatchObject({ runId: RUN_ID, alreadyRunning: true });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('reports the winner when two starts race for the one live slot', async () => {
    mocks.create.mockRejectedValue(new Error('unique violation'));
    mocks.runningRun.mockResolvedValueOnce(null).mockResolvedValueOnce(run());

    const started = await service().start({ accountId: ACCOUNT_ID, kind: 'AUTOMATION_FILING' });

    expect(started).toMatchObject({ runId: RUN_ID, alreadyRunning: true });
  });

  it('records progress while the work runs and succeeds at the end', async () => {
    await service().runToCompletion(RUN_ID, async (report) => {
      await report({ processed: 40, total: 100, counts: { messagesLabeled: 40 } });
      return { state: 'SUCCEEDED', processed: 100, total: 100, counts: { messagesLabeled: 100 } };
    });

    expect(mocks.reportProgress).toHaveBeenCalledWith(RUN_ID, {
      processed: 40,
      total: 100,
      counts: { messagesLabeled: 40 },
    });
    expect(mocks.finish).toHaveBeenCalledWith(
      RUN_ID,
      expect.objectContaining({ state: 'SUCCEEDED', processedCount: 100 }),
    );
  });

  // The ending the old contract had nowhere to put: real work, then a reason to stop.
  it('records a stop reason without calling it a failure', async () => {
    await service().runToCompletion(RUN_ID, () =>
      Promise.resolve({
        state: 'STOPPED',
        stopReason: 'DAILY_BUDGET_REACHED',
        errorMessage: 'This run stopped at the daily Gemini budget.',
        counts: { messagesLabeled: 12 },
      }),
    );

    expect(mocks.finish).toHaveBeenCalledWith(
      RUN_ID,
      expect.objectContaining({
        state: 'STOPPED',
        stopReason: 'DAILY_BUDGET_REACHED',
        errorMessage: 'This run stopped at the daily Gemini budget.',
      }),
    );
  });

  it('writes a readable code and message when the work throws', async () => {
    await service().runToCompletion(RUN_ID, () =>
      Promise.reject(new AppError('PROVIDER_RATE_LIMITED', 'Gemini is rate limited.', 503)),
    );

    expect(mocks.finish).toHaveBeenCalledWith(RUN_ID, {
      state: 'FAILED',
      errorCode: 'PROVIDER_RATE_LIMITED',
      errorMessage: 'Gemini is rate limited.',
    });
    expect(mocks.captureApiException).toHaveBeenCalled();
  });

  it('never leaks an unexpected error into the run record', async () => {
    await service().runToCompletion(RUN_ID, () =>
      Promise.reject(new Error('connect ECONNREFUSED 10.0.0.1:5432 password=hunter2')),
    );

    const recorded = mocks.finish.mock.calls[0]?.[1] as { errorCode: string; errorMessage: string };
    expect(recorded.errorCode).toBe('INTERNAL_SERVER_ERROR');
    expect(recorded.errorMessage).not.toContain('hunter2');
  });

  it('keeps a detached run from throwing into a request that already answered', async () => {
    const instance = service();
    instance.runDetached(RUN_ID, () => Promise.reject(new Error('boom')));
    await new Promise((resolve) => setImmediate(resolve));

    expect(mocks.finish).toHaveBeenCalledWith(
      RUN_ID,
      expect.objectContaining({ state: 'FAILED', errorCode: 'INTERNAL_SERVER_ERROR' }),
    );
  });

  it('describes AppError failures verbatim and everything else generically', () => {
    expect(describeFailure(new AppError('AUTOMATION_DISABLED', 'Automation is off.', 503))).toEqual(
      {
        code: 'AUTOMATION_DISABLED',
        message: 'Automation is off.',
      },
    );
    expect(describeFailure(new Error('secret internals')).code).toBe('INTERNAL_SERVER_ERROR');
  });
});

describe('GET /api/activity/runs', () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((incoming, _response, next) => {
    incoming.requestId = 'request-id';
    next();
  });
  app.use('/api/activity', activityRouter);
  app.use(errorHandler);

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.authenticate.mockResolvedValue({
      id: 'session-id',
      user: { id: 'user-id', email: 'user@example.com', status: 'ACTIVE' },
    });
    mocks.activeAccountForUser.mockResolvedValue({ id: ACCOUNT_ID });
  });

  it('returns recent runs with their state, counts, and reason', async () => {
    mocks.recent.mockResolvedValue([
      run({
        state: 'STOPPED',
        stop_reason: 'DAILY_BUDGET_REACHED',
        error_message: 'This run stopped at the daily Gemini budget.',
        processed_count: 120,
        total_count: 250,
        counts: { messagesLabeled: 118, failed: 2 },
        finished_at: new Date('2026-08-20T00:04:00.000Z'),
      }),
    ]);

    const response = await request(app).get('/api/activity/runs');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body.runs[0]).toMatchObject({
      state: 'STOPPED',
      stopReason: 'DAILY_BUDGET_REACHED',
      errorMessage: 'This run stopped at the daily Gemini budget.',
      processedCount: 120,
      totalCount: 250,
      counts: { messagesLabeled: 118, failed: 2 },
      durationMs: 240_000,
    });
  });

  it('rejects a limit outside the allowed range', async () => {
    const response = await request(app).get('/api/activity/runs?limit=5000');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('ACTIVITY_VALIDATION_FAILED');
    expect(mocks.recent).not.toHaveBeenCalled();
  });

  it('404s a run id that belongs to another account', async () => {
    mocks.runForAccount.mockResolvedValue(null);

    const response = await request(app).get(`/api/activity/runs/${RUN_ID}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('ACTIVITY_RUN_NOT_FOUND');
  });
});
