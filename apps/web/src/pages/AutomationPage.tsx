import { useState } from 'react';
import { AlertTriangle, Bot, CheckCircle2, Play, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { RouteLoader } from '@web/components/RouteLoader';
import {
  CoveragePanel,
  InfoTooltip,
  MetricCard,
  ProgressLine,
  WorkflowRail,
} from '@web/components/ProductWorkflow';
import {
  groupAutomationReviewItems,
  type AutomationReviewGroup,
} from '@web/features/automation/groupAutomationReviewItems';
import {
  useAutomationActions,
  useAutomationReview,
  useAutomationStatus,
} from '@web/queries/automationQueries';
import { useGmailSyncStatusQuery } from '@web/queries/gmailQueries';
import { useLabels } from '@web/queries/labelsQueries';
import { getSafeErrorMessage } from '@web/services/errorMessages';

const words = (value: string) =>
  value
    .toLowerCase()
    .split('_')
    .map((word) => `${word[0]?.toUpperCase()}${word.slice(1)}`)
    .join(' ');

const dateTime = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      )
    : 'Not yet';

const automationErrorMessage = (code: string) => {
  const messages: Record<string, string> = {
    PROVIDER_NOT_CONFIGURED: 'Automation has no AI provider key configured yet.',
    PROVIDER_AUTHENTICATION_FAILED:
      'The AI provider credentials need attention before automation can continue.',
    PROVIDER_MODEL_UNAVAILABLE: 'The configured AI model is unavailable to this project.',
    PROVIDER_RATE_LIMITED:
      'The AI provider daily limit is reached. MailMind resumes on the next scheduled run.',
    AUTOMATION_NO_APPROVED_LABELS:
      'Confirm a label set on the Labels screen before automation can file mail.',
  };
  return messages[code] ?? words(code);
};

export function AutomationPage() {
  const status = useAutomationStatus();
  const review = useAutomationReview();
  const sync = useGmailSyncStatusQuery(status.data?.gmailConnected === true);
  const labels = useLabels();
  const actions = useAutomationActions();

  if (status.isLoading) return <RouteLoader label="Loading automation control room" />;

  const run = async () => {
    try {
      const result = await actions.run.mutateAsync();
      if (result.status === 'COMPLETED')
        toast.success('Automation completed and Gmail is updated.');
      else toast.warning('Automation stopped safely with work available to resume.');
    } catch (error) {
      toast.error(getSafeErrorMessage(error, 'Automation could not be completed.'));
    }
  };

  const data = status.data;
  const last = data?.lastRun;
  const items = review.data?.items ?? [];
  const groups = groupAutomationReviewItems(items);
  const cost = ((data?.usageToday.estimatedCostMicrousd ?? 0) / 1_000_000).toFixed(4);
  const approvedLabels = labels.data?.labels.map((label) => label.leafName) ?? [];
  const labelsReady = data?.labelsReady ?? approvedLabels.length > 0;
  const backlog = data?.backlogRemaining ?? 0;

  return (
    <div className="automation-page">
      <header className="automation-hero">
        <div>
          <span className="eyebrow">Daily operations</span>
          <h1>
            Inbox order,
            <br />
            <em>on repeat.</em>
          </h1>
          <p>
            MailMind's AI classifies every new message, using trusted sender patterns as context,
            and Gmail labels are applied only when confidence clears the review threshold.
          </p>
        </div>
        <div
          className={`automation-state automation-state--${data?.gmailConnected ? 'live' : 'off'}`}
          data-tutorial="automation-state"
        >
          {data?.gmailConnected ? <CheckCircle2 /> : <AlertTriangle />}
          <strong>
            {data?.gmailConnected ? 'Gmail automation ready' : 'Gmail needs attention'}
          </strong>
          <span>
            {data?.requiresReauthentication
              ? 'Reconnect Gmail before another run.'
              : data?.running
                ? 'A resumable run is in progress.'
                : `Next daily run: ${dateTime(data?.nextRunAt)}`}
          </span>
        </div>
      </header>

      <WorkflowRail current="automate" sync={sync.data} />
      {!labelsReady && (
        <aside className="automation-empty" role="status" data-tutorial="automation-labels-gate">
          <Bot />
          <strong>Automation is waiting for a label set.</strong>
          <span>
            Approve labels on the Labels screen. Automation files mail only into labels you
            confirmed, and leaves anything that fits none of them in the inbox.
          </span>
        </aside>
      )}
      <CoveragePanel sync={sync.data} loading={sync.isLoading} compact />
      {backlog > 0 && (
        <ProgressLine
          label="Backfill remaining"
          value={
            (sync.data?.syncedMessages ?? 0) > 0
              ? Math.max(
                  0,
                  100 - Math.round((backlog / (sync.data?.syncedMessages ?? backlog)) * 100),
                )
              : 0
          }
          detail={`${backlog} synchronized messages still to file. Runs resume oldest-first until the backlog is clear.`}
        />
      )}

      <section className="automation-metrics" aria-label="Automation summary">
        <MetricCard
          label="Labeled today"
          value={data?.usageToday.messagesLabeled ?? 0}
          tooltip="Messages that received a MailMind Gmail label during today’s automation runs."
        />
        <MetricCard
          label="Awaiting review"
          value={data?.pendingReviewCount ?? 0}
          accent
          tooltip="Uncertain AI classifications held back from Gmail until you approve or skip them."
        />
        <MetricCard
          label="AI calls"
          value={data?.usageToday.providerCalls ?? 0}
          tooltip="Bounded provider requests attempted today, including safely failed attempts."
        />
        <MetricCard
          label="Estimated today"
          value={`$${cost}`}
          tooltip="Notional AI cost calculated from recorded input, cached-input, and output tokens. The free tier bills nothing; this bounds runaway usage."
        />
      </section>

      <section className="automation-run-panel" data-tutorial="automation-run">
        <div>
          <span className="eyebrow">Last run</span>
          <h2>{last ? words(last.status) : 'No automation run yet'}</h2>
          <p>
            {last
              ? `${dateTime(last.startedAt)} · ${last.messagesLabeled} labeled · ${last.patternReused} patterns consulted`
              : 'Start a manual run now or leave the daily schedule enabled.'}
          </p>
          {(last?.lastErrorCode || data?.lastErrorCode) && (
            <ProviderError
              code={last?.lastErrorCode ?? data?.lastErrorCode ?? ''}
              status={last?.lastProviderStatus ?? null}
              providerCode={last?.lastProviderCode ?? null}
              requestId={last?.lastProviderRequestId ?? null}
              retryAt={data?.retryAt ?? null}
            />
          )}
        </div>
        <button
          type="button"
          disabled={!data?.gmailConnected || !data.enabled || data.running || actions.run.isPending}
          onClick={() => void run()}
        >
          {data?.running || actions.run.isPending ? <RefreshCw className="spin" /> : <Play />}
          {data?.running || actions.run.isPending ? 'Running automation…' : 'Run now'}
        </button>
      </section>

      {data?.running && last && (
        <section className="automation-progress" aria-label="Automation progress">
          <ProgressLine
            label="Current automation run"
            value={
              last.messagesSeen > 0
                ? Math.min(100, Math.round((last.aiClassified / last.messagesSeen) * 100))
                : 0
            }
            detail={`${last.aiClassified} AI-classified · ${last.messagesLabeled} labeled · ${last.reviewRequired} sent to review`}
          />
        </section>
      )}

      <section className="automation-usage">
        <div>
          <span className="eyebrow">Usage guardrails</span>
          <h2>Bounded by design</h2>
        </div>
        <dl>
          <div>
            <dt>
              Input tokens
              <InfoTooltip label="Input tokens">
                Non-cached tokens sent to the AI provider today for bounded metadata classification.
              </InfoTooltip>
            </dt>
            <dd>{data?.usageToday.inputTokens.toLocaleString() ?? 0}</dd>
          </div>
          <div>
            <dt>
              Cached input
              <InfoTooltip label="Cached input">
                Input tokens the AI provider reports as served from cache and priced separately.
              </InfoTooltip>
            </dt>
            <dd>{data?.usageToday.cachedInputTokens.toLocaleString() ?? 0}</dd>
          </div>
          <div>
            <dt>
              Output tokens
              <InfoTooltip label="Output tokens">
                Structured classification tokens returned by the AI provider today.
              </InfoTooltip>
            </dt>
            <dd>{data?.usageToday.outputTokens.toLocaleString() ?? 0}</dd>
          </div>
          <div>
            <dt>
              Per-run message cap
              <InfoTooltip label="Per-run message cap">
                The maximum messages selected in one automation run; later runs resume remaining
                unprocessed mail.
              </InfoTooltip>
            </dt>
            <dd>{data?.limits?.messages ?? '—'}</dd>
          </div>
        </dl>
      </section>

      <section className="automation-review" data-tutorial="automation-review">
        <div className="automation-review__heading">
          <div>
            <span className="eyebrow">Uncertain classifications</span>
            <h2>Human judgment, exactly where it matters</h2>
          </div>
          <span>
            {items.length} messages · {groups.length} visual groups
          </span>
        </div>
        {review.isLoading ? (
          <RouteLoader label="Loading uncertain classifications" />
        ) : items.length === 0 ? (
          <div className="automation-empty">
            <Bot />
            <strong>
              {(sync.data?.unprocessedMessages ?? 0) > 0
                ? 'Unprocessed mail is ready for automation.'
                : 'Nothing needs review.'}
            </strong>
            <span>
              {(sync.data?.unprocessedMessages ?? 0) > 0
                ? `Run automation to classify the remaining ${sync.data?.unprocessedMessages ?? 0} messages.`
                : 'The synchronized mailbox is caught up; future uncertain results will appear here.'}
            </span>
          </div>
        ) : (
          <div className="automation-review-list">
            {groups.map((group) => (
              <ReviewCard
                key={group.key}
                group={group}
                approvedLabels={approvedLabels}
                busy={actions.approve.isPending || actions.skip.isPending}
                onApprove={async (labelName) => {
                  try {
                    await Promise.all(
                      group.members.map((item) =>
                        actions.approve.mutateAsync({ id: item.id, labelName }),
                      ),
                    );
                    toast.success(
                      group.members.length > 1
                        ? `${group.members.length} separate messages approved and labeled.`
                        : 'Label approved and applied in Gmail.',
                    );
                  } catch (error) {
                    toast.error(getSafeErrorMessage(error, 'Review could not be applied.'));
                  }
                }}
                onSkip={async () => {
                  await Promise.all(group.members.map((item) => actions.skip.mutateAsync(item.id)));
                  toast.success(
                    group.members.length > 1
                      ? `${group.members.length} separate messages skipped. Gmail was not changed.`
                      : 'Message skipped. Gmail was not changed.',
                  );
                }}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ReviewCard({
  group,
  approvedLabels,
  busy,
  onApprove,
  onSkip,
}: {
  group: AutomationReviewGroup;
  approvedLabels: string[];
  busy: boolean;
  onApprove: (labelName: string) => Promise<void>;
  onSkip: () => Promise<void>;
}) {
  const item = group.primary;
  const options = approvedLabels.includes(item.labelName)
    ? approvedLabels
    : [item.labelName, ...approvedLabels];
  const [labelName, setLabelName] = useState(item.labelName);
  return (
    <article className="automation-review-card">
      <div>
        <span className="eyebrow">{item.message.senderEmail ?? 'Unknown sender'}</span>
        <h3>{item.message.subject}</h3>
        <p>{item.message.snippet ?? 'No synchronized snippet available.'}</p>
        {group.members.length > 1 && (
          <details className="message-group">
            <summary>{group.members.length} visually identical messages grouped</summary>
            <p>Each Gmail message keeps its own durable action ID.</p>
            <ul>
              {group.members.map((member) => (
                <li key={member.id}>
                  Action ID <code>{member.id}</code>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <div className="automation-review-card__decision">
        <span>{Math.round(item.confidence * 100)}% confidence</span>
        <InfoTooltip label={`automation confidence for ${item.id}`}>
          Results below the automation threshold are held here and never applied without review.
        </InfoTooltip>
        <p>{item.explanation}</p>
        <label>
          Apply as
          <select value={labelName} onChange={(event) => setLabelName(event.target.value)}>
            {options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <div>
          <button type="button" disabled={busy} onClick={() => void onApprove(labelName)}>
            Approve & apply
          </button>
          <button className="quiet" type="button" disabled={busy} onClick={() => void onSkip()}>
            Skip
          </button>
        </div>
      </div>
    </article>
  );
}

function ProviderError({
  code,
  status,
  providerCode,
  requestId,
  retryAt,
}: {
  code: string;
  status: number | null;
  providerCode: string | null;
  requestId: string | null;
  retryAt: string | null;
}) {
  return (
    <aside className="provider-error" role="alert">
      <AlertTriangle aria-hidden="true" />
      <div>
        <strong>{automationErrorMessage(code)}</strong>
        <p>
          Mail content and credentials are never included in this diagnostic.
          {status ? ` Provider status: ${status}.` : ''}
          {providerCode ? ` Safe code: ${providerCode}.` : ''}
          {requestId ? ` Request reference: ${requestId}.` : ''}
        </p>
        {retryAt && <small>Next automatic retry: {dateTime(retryAt)}</small>}
      </div>
    </aside>
  );
}
