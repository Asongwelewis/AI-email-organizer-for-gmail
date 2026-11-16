import type { activity_run_kind, activity_runs, automation_trigger } from '@prisma/client';

import { logger, safeErrorDetails } from '@api/config/logger.js';
import { AppError } from '@api/errors/AppError.js';
import { captureApiException } from '@api/observability/sentry.js';
import { activityRepository, type ActivityRepository } from './activity.repository.js';

export interface RunProgress {
  processed?: number;
  total?: number | null;
  counts?: Record<string, number>;
}

/** Reports progress from inside long-running work. Also the run's heartbeat. */
export type ProgressReporter = (progress: RunProgress) => Promise<void>;

/**
 * How work ends when it does not throw. `STOPPED` is the outcome the old contract had nowhere to
 * put: the run did what it could and quit for a reason the user needs to read — the daily budget
 * was reached, the provider rate-limited us, no labels are approved yet.
 */
export interface RunOutcome {
  state: 'SUCCEEDED' | 'STOPPED';
  stopReason?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  counts?: Record<string, number>;
  processed?: number;
  total?: number | null;
  featureRunId?: string | null;
}

export interface StartedRun {
  runId: string;
  state: 'RUNNING';
  kind: activity_run_kind;
  startedAt: string;
  /** True when this request joined a run that was already in flight rather than starting one. */
  alreadyRunning: boolean;
}

/**
 * A failure the user should be able to read. AppError messages are written for exactly that and
 * carry no tokens, provider payloads, or message content; anything else stays generic, exactly as
 * a 500 response would.
 */
export function describeFailure(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message.slice(0, 500) };
  }
  return {
    code: 'INTERNAL_SERVER_ERROR',
    message: 'This run failed unexpectedly. The error was reported and no work was lost.',
  };
}

export class ActivityService {
  constructor(private readonly repository: ActivityRepository = activityRepository) {}

  /**
   * Claims the one live slot for this account and kind. A second request while a run is in flight
   * joins that run instead of starting a rival one, so a double-clicked button is harmless.
   */
  async start(input: {
    accountId: string;
    kind: activity_run_kind;
    trigger?: automation_trigger;
    totalCount?: number | null;
  }): Promise<StartedRun> {
    await this.repository.reclaimAbandoned(input.accountId, input.kind);
    const existing = await this.repository.runningRun(input.accountId, input.kind);
    if (existing) return this.started(existing, true);
    try {
      const created = await this.repository.create({
        accountId: input.accountId,
        kind: input.kind,
        trigger: input.trigger ?? 'MANUAL',
        totalCount: input.totalCount ?? null,
      });
      return this.started(created, false);
    } catch {
      // Lost the race against a concurrent start; the winner's run is the one to report.
      const winner = await this.repository.runningRun(input.accountId, input.kind);
      if (winner) return this.started(winner, true);
      throw new AppError('ACTIVITY_RUN_CONFLICT', 'That operation is already running.', 409);
    }
  }

  /**
   * Detaches the work from the request. The endpoint has already answered 202, so nothing here may
   * throw into an open response: every ending, including a crash, becomes a row the client polls.
   */
  runDetached(runId: string, work: (report: ProgressReporter) => Promise<RunOutcome>): void {
    void this.runToCompletion(runId, work);
  }

  async runToCompletion(
    runId: string,
    work: (report: ProgressReporter) => Promise<RunOutcome>,
  ): Promise<void> {
    const report: ProgressReporter = (progress) => this.repository.reportProgress(runId, progress);
    try {
      const outcome = await work(report);
      await this.repository.finish(runId, {
        state: outcome.state,
        stopReason: outcome.stopReason ?? null,
        errorCode: outcome.errorCode ?? null,
        errorMessage: outcome.errorMessage ?? null,
        processedCount: outcome.processed,
        totalCount: outcome.total,
        counts: outcome.counts,
        featureRunId: outcome.featureRunId,
      });
    } catch (error) {
      const failure = describeFailure(error);
      // Sentry owns the exception; the run record owns the explanation the user reads.
      captureApiException(error, { operation: 'activity_run' });
      logger.error({ ...safeErrorDetails(error), runId }, 'activity run failed');
      try {
        await this.repository.finish(runId, {
          state: 'FAILED',
          errorCode: failure.code,
          errorMessage: failure.message,
        });
      } catch (finishError) {
        logger.error({ ...safeErrorDetails(finishError), runId }, 'activity run finish failed');
      }
    }
  }

  /**
   * Closes a run the caller drove itself, for work short enough to answer inline. Never throws:
   * failing to record an ending must not turn a succeeded operation into an error.
   */
  async finishRun(
    runId: string,
    outcome: RunOutcome | { state: 'FAILED'; errorCode: string; errorMessage: string },
  ): Promise<void> {
    try {
      await this.repository.finish(runId, {
        state: outcome.state,
        stopReason: 'stopReason' in outcome ? (outcome.stopReason ?? null) : null,
        errorCode: outcome.errorCode ?? null,
        errorMessage: outcome.errorMessage ?? null,
        ...('processed' in outcome ? { processedCount: outcome.processed } : {}),
        ...('total' in outcome ? { totalCount: outcome.total } : {}),
        ...('counts' in outcome ? { counts: outcome.counts } : {}),
        ...('featureRunId' in outcome ? { featureRunId: outcome.featureRunId } : {}),
      });
    } catch (error) {
      logger.error({ ...safeErrorDetails(error), runId }, 'activity run finish failed');
    }
  }

  async attachFeatureRun(runId: string, featureRunId: string): Promise<void> {
    await this.repository.attachFeatureRun(runId, featureRunId);
  }

  async recent(userId: string, limit: number) {
    const account = await this.repository.activeAccountForUser(userId);
    const runs = await this.repository.recent(account.id, limit);
    return { runs: runs.map((run) => this.serialize(run)) };
  }

  async run(userId: string, runId: string) {
    const account = await this.repository.activeAccountForUser(userId);
    const run = await this.repository.runForAccount(account.id, runId);
    if (!run) throw new AppError('ACTIVITY_RUN_NOT_FOUND', 'That run was not found.', 404);
    return this.serialize(run);
  }

  private started(run: activity_runs, alreadyRunning: boolean): StartedRun {
    return {
      runId: run.id,
      state: 'RUNNING',
      kind: run.kind,
      startedAt: run.started_at.toISOString(),
      alreadyRunning,
    };
  }

  private serialize(run: activity_runs) {
    return {
      id: run.id,
      kind: run.kind,
      state: run.state,
      trigger: run.trigger,
      processedCount: run.processed_count,
      totalCount: run.total_count,
      counts: (run.counts ?? {}) as Record<string, number>,
      stopReason: run.stop_reason,
      errorCode: run.error_code,
      errorMessage: run.error_message,
      featureRunId: run.feature_run_id,
      startedAt: run.started_at.toISOString(),
      finishedAt: run.finished_at?.toISOString() ?? null,
      durationMs: (run.finished_at ?? new Date()).getTime() - run.started_at.getTime(),
    };
  }
}

export const activityService = new ActivityService();
