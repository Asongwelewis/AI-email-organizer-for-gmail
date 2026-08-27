import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ErrorNotice } from '@web/components/app/ErrorNotice';
import { formatCount, formatTimestamp, humanizeCode } from '@web/lib/format';
import { queryKeys } from '@web/queries/queryKeys';
import { api } from '@web/services/http';

/**
 * Whether automation is on, when it comes back, and what today has already cost.
 *
 * `getAutomationStatus` has existed since stage 2 and nothing rendered it, so the one question the
 * product's whole promise rests on — *is it still running on its own?* — had no answer anywhere in
 * the interface. The daily budgets are cumulative since 00:00 UTC, which is exactly why today's
 * usage belongs next to the next run time rather than buried in a run record.
 */
/**
 * Why automation is off, said precisely.
 *
 * Three separate things switch it off and the screen used to blame the first one for all of them,
 * which sends someone to change a setting that was already correct — and leaves the real cause
 * untouched while they wonder why nothing happened.
 */
const DISABLED_REASONS: Record<string, string> = {
  AUTOMATION_DISABLED: 'AUTOMATION_ENABLED is false on the server, so nothing runs unattended.',
  AUTOMATION_NOT_CONFIGURED:
    'GEMINI_API_KEY is not set on the server, so there is nothing to classify with. Automation stays off until it is.',
  ACCOUNT_PAUSED: 'Automation is paused for this account.',
  UNKNOWN: 'Automation is off on the server.',
};

export function AutomationPanel() {
  const queryClient = useQueryClient();

  const statusQuery = useQuery({
    queryKey: queryKeys.automationStatus,
    queryFn: () => api.getAutomationStatus(),
    // While a run is in flight this is the only place its existence is visible.
    refetchInterval: (query) => (query.state.data?.running ? 2000 : false),
  });

  const refreshed = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.automationStatus });
    void queryClient.invalidateQueries({ queryKey: queryKeys.activityRuns });
  };

  const runMutation = useMutation({ mutationFn: () => api.runAutomation(), onSuccess: refreshed });
  const syncMutation = useMutation({
    mutationFn: () => api.incrementalGmailSync(),
    onSuccess: () => {
      refreshed();
      void queryClient.invalidateQueries({ queryKey: queryKeys.gmailSyncStatus });
    },
  });

  const status = statusQuery.data;
  if (!status) return null;

  const busy = status.running || runMutation.isPending || syncMutation.isPending;

  return (
    <section className="automation-panel" aria-label="Automation">
      <div className="automation-panel__state">
        <p className="automation-panel__headline">
          {!status.enabled
            ? 'Automation is off'
            : status.running
              ? 'Running now'
              : status.nextRunAt
                ? `Next run ${formatTimestamp(status.nextRunAt)}`
                : 'Scheduled'}
        </p>
        {/* A backoff is not the schedule, and reading one as the other is how a stalled account
            looks healthy. It gets its own line. */}
        {status.retryAt ? (
          <p className="automation-panel__retry">
            Retrying {formatTimestamp(status.retryAt)}
            {status.lastErrorCode ? ` — ${humanizeCode(status.lastErrorCode)}` : ''}
          </p>
        ) : null}
        {!status.enabled ? (
          <p className="automation-panel__retry">
            {DISABLED_REASONS[status.disabledReason ?? 'UNKNOWN']}
          </p>
        ) : null}
      </div>

      <dl className="automation-panel__stats">
        <div>
          <dt>Filed today</dt>
          <dd>{formatCount(status.usageToday.messagesLabeled)}</dd>
        </div>
        <div>
          <dt>Model calls today</dt>
          <dd>{formatCount(status.usageToday.providerCalls)}</dd>
        </div>
        <div>
          <dt>Waiting for review</dt>
          <dd>{formatCount(status.pendingReviewCount)}</dd>
        </div>
        <div>
          <dt>Not yet sorted</dt>
          <dd>{formatCount(status.backlogRemaining)}</dd>
        </div>
      </dl>

      <div className="automation-panel__actions">
        <button
          className="button button--primary"
          type="button"
          disabled={busy || !status.labelsReady}
          onClick={() => runMutation.mutate()}
        >
          {status.running ? 'Running…' : 'Run now'}
        </button>
        <button
          className="button"
          type="button"
          disabled={busy}
          onClick={() => syncMutation.mutate()}
        >
          {syncMutation.isPending ? 'Checking…' : 'Check for new mail'}
        </button>
      </div>

      {!status.labelsReady ? (
        <p className="screen__hint">
          There is nowhere to file yet. Shape your folders and apply them first.
        </p>
      ) : null}

      {runMutation.isError ? <ErrorNotice error={runMutation.error} /> : null}
      {syncMutation.isError ? <ErrorNotice error={syncMutation.error} /> : null}
    </section>
  );
}
