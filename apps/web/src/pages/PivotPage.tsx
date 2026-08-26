import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ErrorNotice } from '@web/components/app/ErrorNotice';
import { EmptyState, LoadingState } from '@web/components/app/StateViews';
import { formatCount } from '@web/lib/format';
import { queryKeys } from '@web/queries/queryKeys';
import { api } from '@web/services/http';
import { FACET_LABELS, PIVOT_FACETS, type PivotFacet, type PivotNode } from '@web/types/facets';

/**
 * Choose the ordering, see the tree it makes, then apply it.
 *
 * Facets are orthogonal, so a folder tree is a **view** of them rather than the thing itself. The
 * same mail is `Netflix > Payment failed` under one ordering and `Finance > Payment failed >
 * Netflix` under another — switching recomputes nothing about the mail, only the arrangement.
 *
 * That is what makes this screen safe to play with: `buildPivot` is a pure function of the stored
 * facets, so every arrangement below is computed on read with no Gmail call and no model call.
 * Only **Apply** touches the mailbox, and only for the ordering marked canonical.
 */

/** Moves a facet within the order. Reordering is the whole interaction, so it stays explicit. */
function move(order: PivotFacet[], index: number, direction: -1 | 1): PivotFacet[] {
  const target = index + direction;
  if (target < 0 || target >= order.length) return order;
  const next = [...order];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

function Tree({ nodes }: { nodes: PivotNode[] }) {
  if (nodes.length === 0) {
    return (
      <EmptyState
        title="No folders at this shape"
        description="Every combination has fewer messages than the minimum. Lower it, or sort more mail first."
      />
    );
  }
  return (
    <ul className="plan-tree">
      {nodes.map((node) => (
        <li
          key={node.facetKey}
          className={`plan-node plan-node--depth-${node.depth}`}
          style={{ paddingLeft: `${(node.depth - 1) * 1.25}rem` }}
        >
          <span className="plan-node__name">{node.leafName}</span>
          <span className="plan-node__count">
            {formatCount(node.isLeaf ? node.messageCount : node.subtreeMessageCount)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function PivotPage() {
  const queryClient = useQueryClient();
  const [order, setOrder] = useState<PivotFacet[] | null>(null);
  const [minMessages, setMinMessages] = useState<number | null>(null);

  const settingsQuery = useQuery({
    queryKey: queryKeys.pivotSettings,
    queryFn: () => api.getPivotSettings(),
  });

  // The stored ordering is the starting point, but only until the person moves something — after
  // that their draft wins, or a refetch would silently undo the change they are looking at.
  useEffect(() => {
    if (settingsQuery.data && order === null) {
      setOrder(settingsQuery.data.canonicalPivot);
      setMinMessages(settingsQuery.data.minMessages);
    }
  }, [settingsQuery.data, order]);

  const effectiveOrder = order ?? settingsQuery.data?.canonicalPivot ?? [];
  const effectiveMin = minMessages ?? settingsQuery.data?.minMessages ?? 5;

  const viewQuery = useQuery({
    queryKey: [...queryKeys.pivotView(effectiveOrder), effectiveMin],
    queryFn: () => api.getPivotView(effectiveOrder, effectiveMin),
    enabled: effectiveOrder.length > 0,
  });

  const applyMutation = useMutation({
    mutationFn: async () => {
      // Save the ordering first: apply materialises whatever is canonical, so applying without
      // saving would build the old shape and quietly discard what is on screen.
      await api.setPivotSettings({ canonicalPivot: effectiveOrder, minMessages: effectiveMin });
      return api.applyPivot();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.pivotSettings });
      void queryClient.invalidateQueries({ queryKey: queryKeys.labels });
      void queryClient.invalidateQueries({ queryKey: queryKeys.activityRuns });
    },
  });

  const fileMutation = useMutation({
    mutationFn: () => api.fileFacets(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.activityRuns });
    },
  });

  const stored = settingsQuery.data?.canonicalPivot ?? [];
  const changed =
    effectiveOrder.join(',') !== stored.join(',') ||
    effectiveMin !== (settingsQuery.data?.minMessages ?? effectiveMin);

  if (settingsQuery.isPending) return <LoadingState label="Loading your folder shape…" />;

  return (
    <section className="screen">
      <header className="screen__head">
        <h1 className="screen__title">Folders</h1>
      </header>
      <p className="screen__lede">
        Your mail already knows what it is about. This decides how it is arranged — drag the levels
        into the order you want and see the tree before anything changes in Gmail.
      </p>

      {settingsQuery.isError ? (
        <ErrorNotice error={settingsQuery.error} onRetry={() => void settingsQuery.refetch()} />
      ) : null}

      <ol className="pivot-order">
        {effectiveOrder.map((facet, index) => (
          <li key={facet} className="pivot-order__item">
            <span className="pivot-order__depth">{index + 1}</span>
            <span className="pivot-order__label">{FACET_LABELS[facet]}</span>
            <span className="pivot-order__controls">
              <button
                className="button button--icon"
                type="button"
                disabled={index === 0}
                aria-label={`Move ${FACET_LABELS[facet]} up`}
                onClick={() => setOrder(move(effectiveOrder, index, -1))}
              >
                ↑
              </button>
              <button
                className="button button--icon"
                type="button"
                disabled={index === effectiveOrder.length - 1}
                aria-label={`Move ${FACET_LABELS[facet]} down`}
                onClick={() => setOrder(move(effectiveOrder, index, 1))}
              >
                ↓
              </button>
              {/* A pivot may name a facet at most once, so removing is how it gets shorter. */}
              <button
                className="button button--quiet"
                type="button"
                disabled={effectiveOrder.length === 1}
                onClick={() => setOrder(effectiveOrder.filter((value) => value !== facet))}
              >
                Remove
              </button>
            </span>
          </li>
        ))}
      </ol>

      {PIVOT_FACETS.filter((facet) => !effectiveOrder.includes(facet)).map((facet) => (
        <button
          key={facet}
          className="button button--quiet"
          type="button"
          onClick={() => setOrder([...effectiveOrder, facet])}
        >
          Add {FACET_LABELS[facet]}
        </button>
      ))}

      <label className="pivot-min">
        <span>Smallest folder</span>
        <input
          type="number"
          min={1}
          max={1000}
          value={effectiveMin}
          onChange={(event) => setMinMessages(Number(event.target.value))}
        />
        <span className="screen__hint">
          A combination with fewer messages than this does not become a folder; its mail files one
          level up.
        </span>
      </label>

      <div className="screen__actions">
        <button
          className="button button--primary"
          type="button"
          disabled={applyMutation.isPending || effectiveOrder.length === 0}
          onClick={() => applyMutation.mutate()}
        >
          {applyMutation.isPending ? 'Applying…' : changed ? 'Save and apply' : 'Apply to Gmail'}
        </button>
        <button
          className="button"
          type="button"
          disabled={fileMutation.isPending}
          onClick={() => fileMutation.mutate()}
        >
          {fileMutation.isPending ? 'Starting…' : 'File my mail'}
        </button>
      </div>

      {applyMutation.isError ? <ErrorNotice error={applyMutation.error} /> : null}
      {fileMutation.isError ? <ErrorNotice error={fileMutation.error} /> : null}

      {applyMutation.isSuccess ? (
        <p className="notice" role="status">
          {formatCount(applyMutation.data.gmailLabelsCreated)} folder(s) created in Gmail,{' '}
          {formatCount(applyMutation.data.gmailLabelsReused)} reused.{' '}
          {applyMutation.data.orphaned.length > 0
            ? `${formatCount(applyMutation.data.orphaned.length)} old folder(s) no longer match anything — they were left alone, because deleting a label does not unlabel its mail.`
            : ''}
        </p>
      ) : null}

      {fileMutation.isSuccess ? (
        <p className="notice" role="status">
          Filing started. It runs in the background — watch it on Activity.
        </p>
      ) : null}

      <h2 className="screen__title screen__title--sub">Preview</h2>
      <p className="screen__hint">
        Computed from what your mail already says about itself. Nothing here has touched Gmail.
      </p>
      {viewQuery.isPending ? <LoadingState label="Building the tree…" /> : null}
      {viewQuery.isError ? (
        <ErrorNotice error={viewQuery.error} onRetry={() => void viewQuery.refetch()} />
      ) : null}
      {viewQuery.data ? (
        <>
          <Tree nodes={viewQuery.data.nodes} />
          <p className="plan-meta">
            <span>{formatCount(viewQuery.data.nodes.length)} folders</span>
            <span>{formatCount(viewQuery.data.collapsed)} too small to be one</span>
            <span>{formatCount(viewQuery.data.unfiled)} staying in the inbox</span>
          </p>
        </>
      ) : null}
    </section>
  );
}
