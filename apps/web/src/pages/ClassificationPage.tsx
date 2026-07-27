import { useState } from 'react';
import { AlertTriangle, BrainCircuit, Check, Play, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { RouteLoader } from '@web/components/RouteLoader';
import {
  CoveragePanel,
  InfoTooltip,
  MetricCard,
  WorkflowRail,
} from '@web/components/ProductWorkflow';
import { useAuth } from '@web/context/useAuth';
import { dedupeRecommendationResults } from '@web/features/classification/dedupeRecommendationResults';
import {
  groupRecommendationResults,
  type RecommendationGroup,
} from '@web/features/classification/groupRecommendationResults';
import {
  useClassificationActions,
  useClassificationResults,
  useClassificationStatus,
} from '@web/queries/classificationQueries';
import { useGmailSyncStatusQuery } from '@web/queries/gmailQueries';
import { getSafeErrorMessage } from '@web/services/errorMessages';
import {
  classificationCategories,
  recommendedActions,
  type ClassificationCategory,
  type RecommendedAction,
} from '@web/types/classification';

const label = (value: string) =>
  value
    .toLowerCase()
    .split('_')
    .map((word) => `${word[0]?.toUpperCase()}${word.slice(1)}`)
    .join(' ');

export function ClassificationPage() {
  const { gmailConnection } = useAuth();
  const connected = gmailConnection?.connected === true;
  const status = useClassificationStatus(connected);
  const results = useClassificationResults(connected);
  const sync = useGmailSyncStatusQuery(connected);
  const actions = useClassificationActions();

  if (!gmailConnection || (connected && status.isLoading)) {
    return <RouteLoader label="Preparing recommendation review" />;
  }

  const run = async () => {
    try {
      await actions.run.mutateAsync();
      toast.success('Classification completed. No Gmail messages were changed.');
    } catch (error) {
      toast.error(getSafeErrorMessage(error, 'Classification could not be completed.'));
    }
  };

  const queue = dedupeRecommendationResults(
    results.data?.pages.flatMap((page) => page.results) ?? [],
  );
  const groups = groupRecommendationResults(queue);

  return (
    <div className="classification-page">
      <header className="classification-hero" data-tutorial="classification-hero">
        <div>
          <span className="eyebrow">Stage 4 / Recommendations</span>
          <h1>
            Review the signal.
            <br />
            <em>You decide.</em>
          </h1>
          <p>
            MailMind analyzes synchronized metadata and suggests categories and actions. These are
            recommendations only: Gmail labels and messages are never changed here.
          </p>
        </div>
        <div className="recommendation-safety">
          <ShieldCheck aria-hidden="true" />
          <strong>No automatic Gmail changes</strong>
          <span>No bodies or attachments are sent or stored by this pipeline.</span>
        </div>
      </header>

      <WorkflowRail current="review" sync={sync.data} />

      {!connected ? (
        <section className="classification-empty">
          <AlertTriangle />
          <h2>Connect and synchronize Gmail first.</h2>
          <p>The classifier only works on metadata already stored by MailMind.</p>
        </section>
      ) : status.isError ? (
        <section className="classification-empty">
          <AlertTriangle />
          <h2>Classification status is unavailable.</h2>
          <p>Try again after confirming the Gmail connection.</p>
        </section>
      ) : (
        <>
          <CoveragePanel sync={sync.data} loading={sync.isLoading} compact />

          <section className="classification-overview">
            <MetricCard
              label="Classified"
              value={status.data?.classifiedCount ?? 0}
              tooltip="Messages with a current completed or review-required recommendation."
            />
            <MetricCard
              label="Needs review"
              value={status.data?.reviewRequiredCount ?? 0}
              accent
              tooltip="Low-confidence recommendations waiting for a human decision."
            />
            <MetricCard
              label="Rules / AI"
              value={`${status.data?.latestRun?.ruleClassifiedCount ?? 0} / ${
                status.data?.latestRun?.aiClassifiedCount ?? 0
              }`}
              tooltip="Rules are deterministic matches. AI handles messages where rules are not confident enough."
            />
            <div className="classification-run-card" id="classification-run">
              <span className="eyebrow">
                {status.data?.enabled ? status.data.provider : 'Rules-only mode'}
              </span>
              <button
                type="button"
                disabled={actions.run.isPending || status.data?.running}
                onClick={() => void run()}
              >
                <Play aria-hidden="true" />
                {actions.run.isPending || status.data?.running
                  ? 'Classifying…'
                  : 'Run classification'}
              </button>
              {!status.data?.enabled && (
                <small>
                  External AI is disabled. High-confidence rules still produce recommendations.
                </small>
              )}
              {status.data?.running && status.data.latestRun && (
                <small role="status">
                  Processing {status.data.latestRun.processedMessageCount} of{' '}
                  {status.data.latestRun.requestedMessageCount} selected messages.
                </small>
              )}
            </div>
          </section>

          <section className="classification-mode-explainer" aria-label="Rules versus AI">
            <article>
              <span className="eyebrow">Rules</span>
              <h2>Fast, deterministic signals</h2>
              <p>
                Rules classify only when known metadata patterns are strong enough. They cost no AI
                tokens and always produce the same result for the same metadata.
              </p>
            </article>
            <article>
              <span className="eyebrow">OpenAI</span>
              <h2>Primary classifier for unresolved mail</h2>
              <p>
                OpenAI evaluates every new or unprocessed automation message in bounded batches.
                Uncertain results are held for review instead of changing Gmail.
              </p>
            </article>
          </section>

          <section className="classification-distributions" aria-label="Recommendation summary">
            <Distribution
              title="Category distribution"
              tooltip="How current classifications are divided across MailMind categories."
              values={status.data?.categoryDistribution ?? {}}
            />
            <Distribution
              title="Recommendation distribution"
              tooltip="How current classifications are divided across suggested next actions."
              values={status.data?.recommendationDistribution ?? {}}
            />
          </section>

          <section className="review-section">
            <div className="review-section__heading">
              <div>
                <span className="eyebrow">Review queue</span>
                <h2>Recommendations needing your eye</h2>
              </div>
              <span>
                {queue.length} messages · {groups.length} visual groups
              </span>
            </div>
            {results.isLoading ? (
              <RouteLoader label="Loading recommendations" />
            ) : queue.length === 0 ? (
              <div className="classification-empty classification-empty--light">
                <Check />
                <h2>
                  {(sync.data?.unprocessedMessages ?? 0) > 0
                    ? 'New messages still need classification.'
                    : 'Review is complete.'}
                </h2>
                <p>
                  {(sync.data?.unprocessedMessages ?? 0) > 0
                    ? `Run classification for the remaining ${sync.data?.unprocessedMessages ?? 0} messages.`
                    : 'The next useful step is to discover recurring label patterns.'}
                </p>
                <a
                  className="next-action"
                  href={
                    (sync.data?.unprocessedMessages ?? 0) > 0
                      ? '#classification-run'
                      : '/dashboard/labels/discover'
                  }
                >
                  {(sync.data?.unprocessedMessages ?? 0) > 0
                    ? 'Run classification'
                    : 'Discover labels'}
                </a>
              </div>
            ) : (
              <div className="review-queue">
                {groups.map((group) => (
                  <RecommendationCard
                    key={group.key}
                    group={group}
                    busy={actions.correct.isPending}
                    onCorrect={async (category, recommendedAction) => {
                      try {
                        await Promise.all(
                          group.members.map((result) =>
                            actions.correct.mutateAsync({
                              id: result.id,
                              category,
                              recommendedAction,
                            }),
                          ),
                        );
                        toast.success(
                          group.members.length > 1
                            ? `Correction saved for ${group.members.length} separate messages. Gmail was not changed.`
                            : 'Correction saved. Gmail was not changed.',
                        );
                      } catch (error) {
                        toast.error(getSafeErrorMessage(error, 'Correction could not be saved.'));
                      }
                    }}
                  />
                ))}
              </div>
            )}
            {results.hasNextPage && (
              <button
                className="load-more"
                type="button"
                disabled={results.isFetchingNextPage}
                onClick={() => void results.fetchNextPage()}
              >
                {results.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Distribution({
  title,
  tooltip,
  values,
}: {
  title: string;
  tooltip: string;
  values: Partial<Record<string, number>>;
}) {
  const entries = Object.entries(values)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .sort((left, right) => right[1] - left[1]);
  return (
    <article className="distribution-card">
      <span className="eyebrow metric-heading">
        {title}
        <InfoTooltip label={title}>{tooltip}</InfoTooltip>
      </span>
      {entries.length === 0 ? (
        <p>No completed recommendations yet.</p>
      ) : (
        <dl>
          {entries.map(([name, count]) => (
            <div key={name}>
              <dt>{label(name)}</dt>
              <dd>{count}</dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}

function RecommendationCard({
  group,
  busy,
  onCorrect,
}: {
  group: RecommendationGroup;
  busy: boolean;
  onCorrect: (
    category: ClassificationCategory,
    recommendedAction: RecommendedAction,
  ) => Promise<void>;
}) {
  const result = group.primary;
  const [category, setCategory] = useState(
    result.correction?.correctedCategory ?? result.recommendedCategory,
  );
  const [action, setAction] = useState(
    result.correction?.correctedRecommendedAction ?? result.suggestedAction,
  );
  return (
    <article className="recommendation-card">
      <div className="recommendation-card__message">
        <span className="eyebrow">
          {result.message.sender}
          {result.message.senderDomain ? ` · ${result.message.senderDomain}` : ''}
        </span>
        <h3>{result.message.subject || 'No subject'}</h3>
        <p>{result.message.snippet || 'No synchronized snippet available.'}</p>
        <div className="gmail-label-list">
          {result.message.gmailLabels.slice(0, 5).map((gmailLabel) => (
            <span key={gmailLabel}>{gmailLabel}</span>
          ))}
        </div>
        {group.members.length > 1 && (
          <details className="message-group">
            <summary>{group.members.length} visually identical messages grouped</summary>
            <p>
              Each Gmail message remains separate. Saving a correction updates every listed
              recommendation independently.
            </p>
            <ul>
              {group.members.map((member) => (
                <li key={member.id}>
                  Message ID <code>{member.messageId}</code>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <div className="recommendation-card__decision">
        <div className="confidence-row">
          <BrainCircuit aria-hidden="true" />
          <span>Classifier confidence</span>
          <InfoTooltip label={`confidence for ${result.id}`}>
            Confidence reflects the classifier’s certainty from synchronized metadata. Low values
            are held for review.
          </InfoTooltip>
          <strong>{Math.round(result.confidence * 100)}%</strong>
        </div>
        <div
          className="confidence-meter"
          role="meter"
          aria-valuenow={Math.round(result.confidence * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span style={{ width: `${result.confidence * 100}%` }} />
        </div>
        <p>{result.explanation}</p>
        <label>
          Recommended category
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value as ClassificationCategory)}
          >
            {classificationCategories.map((item) => (
              <option key={item} value={item}>
                {label(item)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Suggested action
          <select
            value={action}
            onChange={(event) => setAction(event.target.value as RecommendedAction)}
          >
            {recommendedActions.map((item) => (
              <option key={item} value={item}>
                {label(item)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={busy} onClick={() => void onCorrect(category, action)}>
          {result.correction ? 'Update correction' : 'Save correction'}
        </button>
        <small>Saving this correction does not modify Gmail.</small>
      </div>
    </article>
  );
}
