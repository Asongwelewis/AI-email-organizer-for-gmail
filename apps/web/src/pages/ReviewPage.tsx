import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ErrorNotice } from '@web/components/app/ErrorNotice';
import { EmptyState, LoadingState } from '@web/components/app/StateViews';
import { queryKeys } from '@web/queries/queryKeys';
import { api } from '@web/services/http';
import type { AutomationReviewItem } from '@web/types/automation';

/**
 * The queue of messages automation was not confident enough to file on its own.
 *
 * Both endpoints have existed since stage 2 and nothing called them, so every uncertain decision
 * has been accumulating with no way to answer it. A held message is not filed: approving is what
 * moves it, and skipping leaves it in the inbox deliberately rather than by neglect.
 */

/** A confidence is only meaningful next to the bar it failed to clear. */
function Confidence({ value }: { value: number }) {
  return (
    <span className="review__confidence" title={`Model confidence ${Math.round(value * 100)}%`}>
      {Math.round(value * 100)}% sure
    </span>
  );
}

function ReviewCard({
  item,
  onApprove,
  onSkip,
  busy,
}: {
  item: AutomationReviewItem;
  onApprove: () => void;
  onSkip: () => void;
  busy: boolean;
}) {
  return (
    <li className="review">
      <div className="review__mail">
        <p className="review__subject">{item.message.subject || '(no subject)'}</p>
        <p className="review__sender">
          {item.message.senderName ?? item.message.senderEmail ?? 'Unknown sender'}
        </p>
        {item.message.snippet ? <p className="review__snippet">{item.message.snippet}</p> : null}
      </div>

      <div className="review__decision">
        <p className="review__proposal">
          Suggested folder <strong>{item.labelPath || item.labelName}</strong>
        </p>
        <Confidence value={item.confidence} />
        {item.explanation ? <p className="review__why">{item.explanation}</p> : null}
      </div>

      <div className="review__actions">
        <button
          className="button button--primary"
          type="button"
          disabled={busy}
          onClick={onApprove}
        >
          File it here
        </button>
        <button className="button button--quiet" type="button" disabled={busy} onClick={onSkip}>
          Leave in inbox
        </button>
      </div>
    </li>
  );
}

export function ReviewPage() {
  const queryClient = useQueryClient();

  const reviewQuery = useQuery({
    queryKey: queryKeys.automationReview,
    queryFn: () => api.getAutomationReview(),
  });

  const settled = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.automationReview });
    void queryClient.invalidateQueries({ queryKey: queryKeys.automationStatus });
  };

  const approveMutation = useMutation({
    mutationFn: ({ id, labelName }: { id: string; labelName: string }) =>
      api.approveAutomationReview(id, labelName),
    onSuccess: settled,
  });

  const skipMutation = useMutation({
    mutationFn: (id: string) => api.skipAutomationReview(id),
    onSuccess: settled,
  });

  const items = reviewQuery.data?.items ?? [];
  const busy = approveMutation.isPending || skipMutation.isPending;

  return (
    <section className="screen">
      <header className="screen__head">
        <h1 className="screen__title">Review</h1>
      </header>
      <p className="screen__lede">
        Mail the classifier was not sure enough about to file on its own. Nothing here has moved in
        Gmail yet.
      </p>

      {reviewQuery.isError ? (
        <ErrorNotice error={reviewQuery.error} onRetry={() => void reviewQuery.refetch()} />
      ) : null}
      {approveMutation.isError ? <ErrorNotice error={approveMutation.error} /> : null}
      {skipMutation.isError ? <ErrorNotice error={skipMutation.error} /> : null}

      {reviewQuery.isPending ? <LoadingState label="Loading the queue…" /> : null}

      {!reviewQuery.isPending && items.length === 0 ? (
        <EmptyState
          title="Nothing waiting"
          description="Every message so far was filed confidently, or there is no mail to file yet."
        />
      ) : null}

      {items.length > 0 ? (
        <ul className="review-list">
          {items.map((item) => (
            <ReviewCard
              key={item.id}
              item={item}
              busy={busy}
              onApprove={() =>
                approveMutation.mutate({
                  id: item.id,
                  // The full path, never the leaf: a pivot repeats its lower levels, so
                  // "Payment failed" exists under every brand that has one.
                  labelName: item.labelPath || item.labelName,
                })
              }
              onSkip={() => skipMutation.mutate(item.id)}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
