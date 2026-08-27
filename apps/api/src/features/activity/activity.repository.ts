import type {
  Prisma,
  activity_run_kind,
  activity_run_state,
  automation_trigger,
} from '@prisma/client';

import { prisma } from '@api/database/prisma.js';
import { AppError } from '@api/errors/AppError.js';

/**
 * How long a run may go without reporting before another start may reclaim it. Long enough that a
 * slow Gemini batch or a Gmail retry does not look dead, short enough that a killed process does
 * not block the next run for the rest of the day.
 */
export const RUN_EXPIRY_SECONDS = 300;

export interface CreateRunInput {
  accountId: string;
  kind: activity_run_kind;
  trigger: automation_trigger;
  totalCount?: number | null;
}

export interface FinishRunInput {
  state: Exclude<activity_run_state, 'RUNNING'>;
  stopReason?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  processedCount?: number | undefined;
  totalCount?: number | null | undefined;
  counts?: Record<string, number> | undefined;
  featureRunId?: string | null | undefined;
}

function expiry(): Date {
  return new Date(Date.now() + RUN_EXPIRY_SECONDS * 1000);
}

export class ActivityRepository {
  async activeAccountForUser(userId: string) {
    const account = await prisma.connected_google_accounts.findFirst({
      where: { user_id: userId, gmail_connected: true, connection_status: 'CONNECTED' },
      orderBy: { updated_at: 'desc' },
    });
    if (!account) {
      throw new AppError('GMAIL_ACCOUNT_NOT_CONNECTED', 'Connect Gmail first.', 409);
    }
    return account;
  }

  runningRun(accountId: string, kind: activity_run_kind) {
    return prisma.activity_runs.findFirst({
      where: { connected_google_account_id: accountId, kind, state: 'RUNNING' },
    });
  }

  /**
   * Fails any run of this kind whose process stopped reporting, so a crashed instance cannot hold
   * the one-live-run index forever. The lease and checkpoints mean no work was lost.
   */
  async reclaimAbandoned(accountId: string, kind: activity_run_kind): Promise<number> {
    const reclaimed = await prisma.activity_runs.updateMany({
      where: {
        connected_google_account_id: accountId,
        kind,
        state: 'RUNNING',
        expires_at: { lt: new Date() },
      },
      data: {
        state: 'FAILED',
        finished_at: new Date(),
        error_code: 'RUN_ABANDONED',
        error_message:
          'This run stopped reporting progress, usually because the server restarted. No work was lost; run it again to continue.',
      },
    });
    return reclaimed.count;
  }

  create(input: CreateRunInput) {
    return prisma.activity_runs.create({
      data: {
        connected_google_account_id: input.accountId,
        kind: input.kind,
        trigger: input.trigger,
        total_count: input.totalCount ?? null,
        expires_at: expiry(),
      },
    });
  }

  /** Also pushes the expiry out: reporting progress is the run's heartbeat. */
  async reportProgress(
    id: string,
    progress: { processed?: number; total?: number | null; counts?: Record<string, number> },
  ): Promise<void> {
    await prisma.activity_runs.updateMany({
      where: { id, state: 'RUNNING' },
      data: {
        ...(progress.processed === undefined ? {} : { processed_count: progress.processed }),
        ...(progress.total === undefined ? {} : { total_count: progress.total }),
        ...(progress.counts === undefined
          ? {}
          : { counts: progress.counts as Prisma.InputJsonValue }),
        expires_at: expiry(),
      },
    });
  }

  async finish(id: string, input: FinishRunInput): Promise<void> {
    await prisma.activity_runs.updateMany({
      where: { id, state: 'RUNNING' },
      data: {
        state: input.state,
        finished_at: new Date(),
        stop_reason: input.stopReason ?? null,
        error_code: input.errorCode ?? null,
        error_message: input.errorMessage ?? null,
        ...(input.processedCount === undefined ? {} : { processed_count: input.processedCount }),
        ...(input.totalCount === undefined ? {} : { total_count: input.totalCount }),
        ...(input.counts === undefined ? {} : { counts: input.counts as Prisma.InputJsonValue }),
        ...(input.featureRunId === undefined ? {} : { feature_run_id: input.featureRunId }),
      },
    });
  }

  async attachFeatureRun(id: string, featureRunId: string): Promise<void> {
    await prisma.activity_runs.updateMany({
      where: { id, state: 'RUNNING' },
      data: { feature_run_id: featureRunId, expires_at: expiry() },
    });
  }

  recent(accountId: string, limit: number) {
    return prisma.activity_runs.findMany({
      where: { connected_google_account_id: accountId },
      orderBy: { started_at: 'desc' },
      take: limit,
    });
  }

  runForAccount(accountId: string, id: string) {
    return prisma.activity_runs.findFirst({
      where: { id, connected_google_account_id: accountId },
    });
  }
}

export const activityRepository = new ActivityRepository();
