import { useState } from 'react';
import { AlertTriangle, Layers3, Play, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { RouteLoader } from '@web/components/RouteLoader';
import { useAuth } from '@web/context/useAuth';
import {
  useLabelCandidates,
  useLabelDiscoveryActions,
  useLabelDiscoveryStatus,
} from '@web/queries/labelDiscoveryQueries';
import { getSafeErrorMessage } from '@web/services/errorMessages';
import type { LabelCandidate } from '@web/types/labelDiscovery';

const titleCase = (value: string) =>
  value
    .toLowerCase()
    .split('_')
    .map((word) => `${word[0]?.toUpperCase()}${word.slice(1)}`)
    .join(' ');

export function LabelDiscoveryPage() {
  const { gmailConnection } = useAuth();
  const connected = gmailConnection?.connected === true;
  const status = useLabelDiscoveryStatus(connected);
  const candidates = useLabelCandidates(connected);
  const actions = useLabelDiscoveryActions();

  if (!gmailConnection || (connected && status.isLoading)) {
    return <RouteLoader label="Preparing label discovery" />;
  }

  const list = candidates.data?.pages.flatMap((page) => page.candidates) ?? [];
  const busy =
    actions.approve.isPending ||
    actions.reject.isPending ||
    actions.defer.isPending ||
    actions.merge.isPending;
  const run = async () => {
    try {
      await actions.run.mutateAsync();
      toast.success('Suggestions discovered. Gmail was not changed.');
    } catch (error) {
      toast.error(getSafeErrorMessage(error, 'Label discovery could not be completed.'));
    }
  };

  return (
    <div className="label-discovery-page">
      <header className="label-discovery-hero">
        <div>
          <span className="eyebrow">Stage 4.5 / Label discovery</span>
          <h1>
            Find the pattern.
            <br />
            <em>Approve the label.</em>
          </h1>
          <p>
            MailMind groups synchronized metadata into controlled label suggestions. Approval
            records your decision only; no Gmail label is created or applied in this stage.
          </p>
        </div>
        <div className="recommendation-safety">
          <ShieldCheck aria-hidden="true" />
          <strong>No Gmail message changes</strong>
          <span>Only metadata, classifications, and safe reason codes are analyzed.</span>
        </div>
      </header>

      {!connected ? (
        <Empty
          title="Connect and synchronize Gmail first."
          detail="Discovery only analyzes metadata already stored by MailMind."
        />
      ) : status.isError ? (
        <Empty
          title="Label discovery status is unavailable."
          detail="Try again after confirming the Gmail connection."
        />
      ) : (
        <>
          <section className="label-discovery-overview">
            <Stat title="Pending" value={status.data?.pendingCount ?? 0} />
            <Stat title="Approved" value={status.data?.approvedCount ?? 0} />
            <Stat title="Messages analyzed" value={status.data?.latestRun?.messagesAnalyzed ?? 0} />
            <div className="label-discovery-run">
              <span className="eyebrow">
                {status.data?.enabled ? 'Metadata discovery ready' : 'Disabled by configuration'}
              </span>
              <button
                type="button"
                disabled={!status.data?.enabled || status.data.running || actions.run.isPending}
                onClick={() => void run()}
              >
                <Play aria-hidden="true" />
                {status.data?.running || actions.run.isPending ? 'Discovering…' : 'Discover labels'}
              </button>
              <small>Suggestions are capped to prevent label explosion.</small>
            </div>
          </section>

          <section className="label-candidate-section">
            <div className="review-section__heading">
              <div>
                <span className="eyebrow">Approval queue</span>
                <h2>Controlled suggestions</h2>
              </div>
              <span>{list.length} shown</span>
            </div>
            {candidates.isLoading ? (
              <RouteLoader label="Loading label suggestions" />
            ) : list.length === 0 ? (
              <Empty
                title="No label suggestions yet."
                detail="Run discovery after synchronizing and classifying enough messages."
              />
            ) : (
              <div className="label-candidate-grid">
                {list.map((candidate) => (
                  <CandidateCard
                    key={candidate.id}
                    candidate={candidate}
                    allCandidates={list}
                    busy={busy}
                    onApprove={async (leafName) => {
                      try {
                        await actions.approve.mutateAsync({
                          id: candidate.id,
                          ...(leafName ? { leafName } : {}),
                        });
                        toast.success('Suggestion approved. Gmail was not changed.');
                      } catch (error) {
                        toast.error(
                          getSafeErrorMessage(error, 'Suggestion could not be approved.'),
                        );
                      }
                    }}
                    onReject={async () => {
                      await actionToast(
                        () => actions.reject.mutateAsync(candidate.id),
                        'Suggestion rejected. Gmail was not changed.',
                      );
                    }}
                    onDefer={async () => {
                      await actionToast(
                        () => actions.defer.mutateAsync(candidate.id),
                        'Suggestion deferred. Gmail was not changed.',
                      );
                    }}
                    onMerge={async (targetCandidateId) => {
                      await actionToast(
                        () =>
                          actions.merge.mutateAsync({
                            id: candidate.id,
                            targetCandidateId,
                          }),
                        'Suggestions merged. Gmail was not changed.',
                      );
                    }}
                  />
                ))}
              </div>
            )}
            {candidates.hasNextPage && (
              <button
                className="load-more"
                type="button"
                disabled={candidates.isFetchingNextPage}
                onClick={() => void candidates.fetchNextPage()}
              >
                {candidates.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            )}
          </section>
        </>
      )}
    </div>
  );
}

async function actionToast(action: () => Promise<unknown>, success: string) {
  try {
    await action();
    toast.success(success);
  } catch (error) {
    toast.error(getSafeErrorMessage(error, 'The label decision could not be saved.'));
  }
}

function CandidateCard({
  candidate,
  allCandidates,
  busy,
  onApprove,
  onReject,
  onDefer,
  onMerge,
}: {
  candidate: LabelCandidate;
  allCandidates: LabelCandidate[];
  busy: boolean;
  onApprove: (leafName?: string) => Promise<void>;
  onReject: () => Promise<void>;
  onDefer: () => Promise<void>;
  onMerge: (targetCandidateId: string) => Promise<void>;
}) {
  const [rename, setRename] = useState(false);
  const [leafName, setLeafName] = useState(candidate.suggestedLeafName);
  const [mergeTarget, setMergeTarget] = useState('');
  const active = candidate.status === 'PENDING' || candidate.status === 'DEFERRED';
  const targets = allCandidates.filter(
    (item) =>
      item.id !== candidate.id &&
      !['REJECTED', 'MERGED', 'SUPERSEDED', 'FAILED'].includes(item.status),
  );
  return (
    <article className="label-candidate-card">
      <div className="label-candidate-card__heading">
        <span className="eyebrow">{titleCase(candidate.candidateType)}</span>
        <span className={`candidate-status candidate-status--${candidate.status.toLowerCase()}`}>
          {titleCase(candidate.status)}
        </span>
      </div>
      <h3>{candidate.suggestedFullPath}</h3>
      <div className="confidence-row">
        <Layers3 aria-hidden="true" />
        <span>{titleCase(candidate.confidenceLevel)} confidence</span>
        <strong>{Math.round(candidate.confidence * 100)}%</strong>
      </div>
      <div
        className="confidence-meter"
        role="meter"
        aria-valuenow={Math.round(candidate.confidence * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span style={{ width: `${candidate.confidence * 100}%` }} />
      </div>
      <dl className="candidate-facts">
        <div>
          <dt>Based on</dt>
          <dd>
            {candidate.messageCount} messages · {candidate.threadCount} threads
          </dd>
        </div>
        <div>
          <dt>Dominant category</dt>
          <dd>{candidate.dominantCategory ? titleCase(candidate.dominantCategory) : 'Mixed'}</dd>
        </div>
      </dl>
      <div className="candidate-reasons" aria-label="Suggestion reasons">
        {candidate.reasons.map((reason) => (
          <span key={reason}>{reason}</span>
        ))}
      </div>
      {candidate.existingLabelConflict && (
        <p className="candidate-warning">A similar Gmail label already exists.</p>
      )}
      {candidate.mergeSuggestion && (
        <p className="candidate-warning">
          Suggested merge: {candidate.mergeSuggestion.path}. You must confirm it explicitly.
        </p>
      )}
      {active && (
        <div className="candidate-actions">
          {rename && (
            <label>
              Rename suggestion
              <input
                value={leafName}
                maxLength={60}
                onChange={(event) => setLeafName(event.target.value)}
              />
            </label>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => void onApprove(rename ? leafName : undefined)}
          >
            Approve suggestion
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setRename((value) => !value)}
          >
            {rename ? 'Use suggested name' : 'Rename and approve'}
          </button>
          <div className="candidate-actions__row">
            <button type="button" className="quiet" disabled={busy} onClick={() => void onDefer()}>
              Defer
            </button>
            <button type="button" className="quiet" disabled={busy} onClick={() => void onReject()}>
              Reject
            </button>
          </div>
          {targets.length > 0 && (
            <div className="candidate-merge">
              <label>
                Merge with
                <select
                  value={mergeTarget}
                  onChange={(event) => setMergeTarget(event.target.value)}
                >
                  <option value="">Choose a suggestion</option>
                  {targets.map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.suggestedFullPath}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="secondary"
                disabled={busy || !mergeTarget}
                onClick={() => void onMerge(mergeTarget)}
              >
                Merge suggestions
              </button>
            </div>
          )}
          <small>Decisions never apply labels to messages.</small>
        </div>
      )}
    </article>
  );
}

function Stat({ title, value }: { title: string; value: number }) {
  return (
    <article className="classification-stat">
      <span>{title}</span>
      <strong>{value}</strong>
    </article>
  );
}

function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <section className="classification-empty">
      <AlertTriangle aria-hidden="true" />
      <h2>{title}</h2>
      <p>{detail}</p>
    </section>
  );
}
