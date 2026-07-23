import { useState } from 'react';
import { AlertTriangle, BrainCircuit, Check, Play, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { RouteLoader } from '@web/components/RouteLoader';
import { useAuth } from '@web/context/useAuth';
import {
  useClassificationActions,
  useClassificationResults,
  useClassificationStatus,
} from '@web/queries/classificationQueries';
import { getSafeErrorMessage } from '@web/services/errorMessages';
import {
  classificationCategories,
  recommendedActions,
  type ClassificationCategory,
  type ClassificationResult,
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

  const queue = results.data?.pages.flatMap((page) => page.results) ?? [];

  return (
    <div className="classification-page">
      <header className="classification-hero">
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
          <section className="classification-overview">
            <Stat label="Classified" value={status.data?.classifiedCount ?? 0} />
            <Stat label="Needs review" value={status.data?.reviewRequiredCount ?? 0} accent />
            <Stat
              label="Rules / AI"
              value={`${status.data?.latestRun?.ruleClassifiedCount ?? 0} / ${
                status.data?.latestRun?.aiClassifiedCount ?? 0
              }`}
            />
            <div className="classification-run-card">
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
            </div>
          </section>

          <section className="classification-distributions" aria-label="Recommendation summary">
            <Distribution
              title="Category distribution"
              values={status.data?.categoryDistribution ?? {}}
            />
            <Distribution
              title="Recommendation distribution"
              values={status.data?.recommendationDistribution ?? {}}
            />
          </section>

          <section className="review-section">
            <div className="review-section__heading">
              <div>
                <span className="eyebrow">Review queue</span>
                <h2>Recommendations needing your eye</h2>
              </div>
              <span>{queue.length} shown</span>
            </div>
            {results.isLoading ? (
              <RouteLoader label="Loading recommendations" />
            ) : queue.length === 0 ? (
              <div className="classification-empty classification-empty--light">
                <Check />
                <h2>No recommendations need review.</h2>
                <p>Run classification after synchronizing new Gmail metadata.</p>
              </div>
            ) : (
              <div className="review-queue">
                {queue.map((result) => (
                  <RecommendationCard
                    key={result.id}
                    result={result}
                    busy={actions.correct.isPending}
                    onCorrect={async (category, recommendedAction) => {
                      try {
                        await actions.correct.mutateAsync({
                          id: result.id,
                          category,
                          recommendedAction,
                        });
                        toast.success('Correction saved. Gmail was not changed.');
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
  values,
}: {
  title: string;
  values: Partial<Record<string, number>>;
}) {
  const entries = Object.entries(values)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .sort((left, right) => right[1] - left[1]);
  return (
    <article className="distribution-card">
      <span className="eyebrow">{title}</span>
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

function Stat({
  label: title,
  value,
  accent = false,
}: {
  label: string;
  value: number | string;
  accent?: boolean;
}) {
  return (
    <article className={`classification-stat${accent ? ' classification-stat--accent' : ''}`}>
      <span>{title}</span>
      <strong>{value}</strong>
    </article>
  );
}

function RecommendationCard({
  result,
  busy,
  onCorrect,
}: {
  result: ClassificationResult;
  busy: boolean;
  onCorrect: (
    category: ClassificationCategory,
    recommendedAction: RecommendedAction,
  ) => Promise<void>;
}) {
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
      </div>
      <div className="recommendation-card__decision">
        <div className="confidence-row">
          <BrainCircuit aria-hidden="true" />
          <span>Classifier confidence</span>
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
