import { useQuery } from '@tanstack/react-query';

import {
  formatCount,
  formatInterval,
  formatRelative,
  formatTimestamp,
  humanizeCode,
} from '@web/lib/format';
import { queryKeys } from '@web/queries/queryKeys';
import { api } from '@web/services/http';

/**
 * Whether automation is on, how fresh it is, and what today has already cost.
 *
 * There are no buttons here any more, on purpose. New mail is checked for every minute and sorted
 * as it lands, and the full job runs twice a day on its own, so "Run now" and "Check for new mail"
 * only ever asked a person to do by hand what was about to happen anyway. What this answers
 * instead is the question the whole product rests on: *is it still running on its own?*
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
  const statusQuery = useQuery({
    queryKey: queryKeys.automationStatus,
    queryFn: () => api.getAutomationStatus(),
    // "Last checked" moves every minute, and a full run's progress is only visible here, so the
    // panel keeps itself current while it is on screen: every 2s during a run, every 30s otherwise.
    refetchInterval: (query) => (query.state.data?.running ? 2000 : 30_000),
  });

  const status = statusQuery.data;
  if (!status) return null;

  const watch = status.watch;
  const watching = status.enabled && Boolean(watch && watch.intervalSeconds > 0);

  return (
    <section className="automation-panel" aria-label="Automation">
      <div className="automation-panel__state">
        <p className="automation-panel__headline">
          {!status.enabled
            ? 'Automation is off'
            : status.running
              ? 'Full run in progress'
              : watching
                ? 'Watching for new mail'
                : 'Scheduled'}
        </p>
        {watching && watch ? (
          <p className="automation-panel__detail">
            Checks {formatInterval(watch.intervalSeconds)}
            {watch.lastCheckedAt ? ` · last checked ${formatRelative(watch.lastCheckedAt)}` : ''}
          </p>
        ) : null}
        {status.enabled && status.nextRunAt ? (
          <p className="automation-panel__detail">
            Next full run {formatTimestamp(status.nextRunAt)}
          </p>
        ) : null}
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
          <dt>Sorted today</dt>
          <dd>{formatCount(status.usageToday.messagesSorted ?? 0)}</dd>
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
    </section>
  );
}
