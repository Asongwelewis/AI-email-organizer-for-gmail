import { useQuery } from '@tanstack/react-query';

import { AutomationPanel } from '@web/components/app/AutomationPanel';
import { ErrorNotice } from '@web/components/app/ErrorNotice';
import { EmptyState, LoadingState } from '@web/components/app/StateViews';
import { formatCount, formatDuration, formatTimestamp, humanizeCode } from '@web/lib/format';
import { queryKeys } from '@web/queries/queryKeys';
import { api } from '@web/services/http';
import type { ActivityRun } from '@web/types/activity';

const KIND_LABELS: Record<ActivityRun['kind'], string> = {
  GMAIL_INITIAL_SYNC: 'Initial sync',
  GMAIL_INCREMENTAL_SYNC: 'Incremental sync',
  GMAIL_LABEL_SYNC: 'Label sync',
  LABEL_PROPOSAL: 'Folder planning',
  AUTOMATION_FILING: 'Filing run',
  FACET_CLASSIFICATION: 'Classifying mail',
};

const STATE_LABELS: Record<ActivityRun['state'], string> = {
  RUNNING: 'Running',
  SUCCEEDED: 'Succeeded',
  STOPPED: 'Stopped',
  FAILED: 'Failed',
};

export function ActivityPage() {
  const runsQuery = useQuery({
    queryKey: queryKeys.activityRuns,
    queryFn: () => api.getActivityRuns(20),
    // Only while something is in flight. A finished list does not need to be re-fetched at all.
    refetchInterval: (query) =>
      query.state.data?.runs.some((run) => run.state === 'RUNNING') ? 2000 : false,
  });

  const runs = runsQuery.data?.runs ?? [];

  return (
    <section className="screen">
      <header className="screen__head">
        <h1 className="screen__title">Activity</h1>
      </header>
      <p className="screen__lede">
        Every sync, planning pass and filing run, newest first, with the reason it ended.
      </p>

      <AutomationPanel />

      {runsQuery.isPending ? <LoadingState label="Loading runs" /> : null}
      {runsQuery.isError ? (
        <ErrorNotice
          error={runsQuery.error}
          title="Runs could not be loaded"
          onRetry={() => void runsQuery.refetch()}
        />
      ) : null}
      {runsQuery.isSuccess && runs.length === 0 ? (
        <EmptyState
          title="Nothing has run yet"
          description="Synchronizing mail, planning folders, or filing will each leave a record here."
        />
      ) : null}

      {runs.length > 0 ? (
        <ol className="run-list">
          {runs.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function RunRow({ run }: { run: ActivityRun }) {
  const counts = Object.entries(run.counts).filter(([, value]) => value > 0);
  const progress =
    run.totalCount && run.totalCount > 0
      ? Math.min(100, Math.round((run.processedCount / run.totalCount) * 100))
      : null;

  return (
    <li className={`run run--${run.state.toLowerCase()}`}>
      <div className="run__head">
        <span className="run__kind">{KIND_LABELS[run.kind]}</span>
        <span className={`badge badge--${run.state.toLowerCase()}`}>{STATE_LABELS[run.state]}</span>
        {run.trigger === 'SCHEDULED' ? <span className="run__trigger">Scheduled</span> : null}
        <time className="run__time" dateTime={run.startedAt}>
          {formatTimestamp(run.startedAt)}
        </time>
      </div>

      <div className="run__progress">
        <span className="run__counts">
          {formatCount(run.processedCount)}
          {run.totalCount === null ? '' : ` / ${formatCount(run.totalCount)}`}
        </span>
        {progress === null ? null : (
          <span
            className="run__bar"
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span className="run__bar-fill" style={{ width: `${progress}%` }} />
          </span>
        )}
        <span className="run__duration">{formatDuration(run.durationMs)}</span>
      </div>

      {/* A stop is not a failure: it says what the run did and why it went no further. */}
      {run.stopReason ? (
        <p className="run__reason">
          <span className="run__reason-code">{run.stopReason}</span>
          {run.errorMessage ? ` ${run.errorMessage}` : ` ${humanizeCode(run.stopReason)}.`}
        </p>
      ) : null}

      {run.errorCode ? (
        <p className="run__reason run__reason--error">
          <span className="run__reason-code">{run.errorCode}</span>
          {run.errorMessage ? ` ${run.errorMessage}` : ` ${humanizeCode(run.errorCode)}.`}
        </p>
      ) : null}

      {counts.length > 0 ? (
        <dl className="run__stats">
          {counts.map(([key, value]) => (
            <div key={key}>
              <dt>{humanizeCode(key.replace(/([A-Z])/g, ' $1'))}</dt>
              <dd>{formatCount(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </li>
  );
}
