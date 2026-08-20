/**
 * Long-running work answers 202 with a run id rather than holding a request open. A full mailbox
 * backfill or a filing run takes minutes, far past any browser timeout, so the client starts the
 * work and then polls the run.
 */
export type ActivityRunKind =
  | 'GMAIL_INITIAL_SYNC'
  | 'GMAIL_INCREMENTAL_SYNC'
  | 'GMAIL_LABEL_SYNC'
  | 'LABEL_PROPOSAL'
  | 'AUTOMATION_FILING';

/**
 * `STOPPED` is not a failure: the run did what it could and quit for a reason worth showing —
 * the daily budget was reached, the provider rate-limited us.
 */
export type ActivityRunState = 'RUNNING' | 'SUCCEEDED' | 'STOPPED' | 'FAILED';

/** The 202 body from `POST /api/gmail/sync/initial` and `POST /api/automation/run`. */
export interface StartedRun {
  runId: string;
  state: 'RUNNING';
  kind: ActivityRunKind;
  startedAt: string;
  /** True when this request joined a run already in flight instead of starting one. */
  alreadyRunning: boolean;
}

export interface ActivityRun {
  id: string;
  kind: ActivityRunKind;
  state: ActivityRunState;
  trigger: 'MANUAL' | 'SCHEDULED';
  processedCount: number;
  totalCount: number | null;
  /** Feature-specific counters, e.g. messagesLabeled, reviewRequired, leaves. */
  counts: Record<string, number>;
  stopReason: string | null;
  errorCode: string | null;
  /** Already safe to display: services build these from user-facing error messages. */
  errorMessage: string | null;
  /** The feature's own detailed record id, when it has one. */
  featureRunId: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
}

export interface ActivityRunsResponse {
  runs: ActivityRun[];
}

export const isRunActive = (run: ActivityRun): boolean => run.state === 'RUNNING';
