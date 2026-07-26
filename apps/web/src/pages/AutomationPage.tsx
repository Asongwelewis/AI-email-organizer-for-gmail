import { useState } from 'react';
import { AlertTriangle, Bot, CheckCircle2, Play, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { RouteLoader } from '@web/components/RouteLoader';
import {
  useAutomationActions,
  useAutomationReview,
  useAutomationStatus,
} from '@web/queries/automationQueries';
import { getSafeErrorMessage } from '@web/services/errorMessages';
import { classificationCategories, type ClassificationCategory } from '@web/types/classification';
import type { AutomationReviewItem } from '@web/types/automation';

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

export function AutomationPage() {
  const status = useAutomationStatus();
  const review = useAutomationReview();
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
  const cost = ((data?.usageToday.estimatedCostMicrousd ?? 0) / 1_000_000).toFixed(4);

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
            OpenAI classifies new mail, MailMind reuses trusted sender patterns, and Gmail labels
            are applied only when confidence clears the review threshold.
          </p>
        </div>
        <div
          className={`automation-state automation-state--${data?.gmailConnected ? 'live' : 'off'}`}
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

      <section className="automation-metrics" aria-label="Automation summary">
        <Metric label="Labeled today" value={data?.usageToday.messagesLabeled ?? 0} />
        <Metric label="Awaiting review" value={data?.pendingReviewCount ?? 0} accent />
        <Metric label="OpenAI calls" value={data?.usageToday.providerCalls ?? 0} />
        <Metric label="Estimated today" value={`$${cost}`} />
      </section>

      <section className="automation-run-panel">
        <div>
          <span className="eyebrow">Last run</span>
          <h2>{last ? words(last.status) : 'No automation run yet'}</h2>
          <p>
            {last
              ? `${dateTime(last.startedAt)} · ${last.messagesLabeled} labeled · ${last.patternReused} patterns reused`
              : 'Start a manual run now or leave the daily schedule enabled.'}
          </p>
          {(last?.lastErrorCode || data?.lastErrorCode) && (
            <p className="automation-error">
              <AlertTriangle /> {words(last?.lastErrorCode ?? data?.lastErrorCode ?? '')}
            </p>
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

      <section className="automation-usage">
        <div>
          <span className="eyebrow">Usage guardrails</span>
          <h2>Bounded by design</h2>
        </div>
        <dl>
          <div>
            <dt>Input tokens</dt>
            <dd>{data?.usageToday.inputTokens.toLocaleString() ?? 0}</dd>
          </div>
          <div>
            <dt>Cached input</dt>
            <dd>{data?.usageToday.cachedInputTokens.toLocaleString() ?? 0}</dd>
          </div>
          <div>
            <dt>Output tokens</dt>
            <dd>{data?.usageToday.outputTokens.toLocaleString() ?? 0}</dd>
          </div>
          <div>
            <dt>Per-run message cap</dt>
            <dd>{data?.limits?.messages ?? '—'}</dd>
          </div>
        </dl>
      </section>

      <section className="automation-review">
        <div className="automation-review__heading">
          <div>
            <span className="eyebrow">Uncertain classifications</span>
            <h2>Human judgment, exactly where it matters</h2>
          </div>
          <span>{items.length} open</span>
        </div>
        {review.isLoading ? (
          <RouteLoader label="Loading uncertain classifications" />
        ) : items.length === 0 ? (
          <div className="automation-empty">
            <Bot />
            <strong>Nothing needs review.</strong>
            <span>Low-confidence messages will appear here without changing Gmail.</span>
          </div>
        ) : (
          <div className="automation-review-list">
            {items.map((item) => (
              <ReviewCard
                key={item.id}
                item={item}
                busy={actions.approve.isPending || actions.skip.isPending}
                onApprove={async (category) => {
                  try {
                    await actions.approve.mutateAsync({ id: item.id, category });
                    toast.success('Classification approved and Gmail label applied.');
                  } catch (error) {
                    toast.error(getSafeErrorMessage(error, 'Review could not be applied.'));
                  }
                }}
                onSkip={async () => {
                  await actions.skip.mutateAsync(item.id);
                  toast.success('Message skipped. Gmail was not changed.');
                }}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
}) {
  return (
    <article className={`automation-metric${accent ? ' automation-metric--accent' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function ReviewCard({
  item,
  busy,
  onApprove,
  onSkip,
}: {
  item: AutomationReviewItem;
  busy: boolean;
  onApprove: (category: ClassificationCategory) => Promise<void>;
  onSkip: () => Promise<void>;
}) {
  const [category, setCategory] = useState(item.category);
  return (
    <article className="automation-review-card">
      <div>
        <span className="eyebrow">{item.message.senderEmail ?? 'Unknown sender'}</span>
        <h3>{item.message.subject}</h3>
        <p>{item.message.snippet ?? 'No synchronized snippet available.'}</p>
      </div>
      <div className="automation-review-card__decision">
        <span>{Math.round(item.confidence * 100)}% confidence</span>
        <p>{item.explanation}</p>
        <label>
          Apply as
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value as ClassificationCategory)}
          >
            {classificationCategories.map((option) => (
              <option key={option} value={option}>
                {words(option)}
              </option>
            ))}
          </select>
        </label>
        <div>
          <button type="button" disabled={busy} onClick={() => void onApprove(category)}>
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
