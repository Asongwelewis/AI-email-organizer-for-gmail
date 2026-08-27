import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { ErrorNotice } from '@web/components/app/ErrorNotice';
import { EmptyState, LoadingState } from '@web/components/app/StateViews';
import { formatCount } from '@web/lib/format';
import { queryKeys } from '@web/queries/queryKeys';
import { api } from '@web/services/http';
import {
  FACET_LABELS,
  PIVOT_FACETS,
  pivotOrderKey,
  type PivotFacet,
  type PivotNode,
} from '@web/types/facets';

/**
 * Shape an arrangement, see the tree it makes, keep it as your default.
 *
 * Facets are orthogonal, so a folder tree is a **view** of them rather than the thing itself. The
 * same mail is `Netflix > Payment failed` under one ordering and `Finance > Payment failed >
 * Netflix` under another — switching recomputes nothing about the mail, only the arrangement.
 *
 * There used to be a canonical one, because a message carries one MailMind label and no more and
 * only one ordering could be written to Gmail. That constraint was Gmail's, and Gmail is no longer
 * in the write path: every ordering is available at once on Sorted, and what is saved here is
 * simply which one that screen opens on.
 *
 * `buildPivot` is a pure function of the stored facets, so everything below is computed on read —
 * no Gmail call, no model call, nothing to undo.
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

  const saveMutation = useMutation({
    mutationFn: () =>
      api.setPivotSettings({ canonicalPivot: effectiveOrder, minMessages: effectiveMin }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.pivotSettings }),
  });

  /*
   * The export path. Applying creates folders in a real mailbox and filing puts one label on each
   * message, and both are opt-in on the server — off unless someone asked for their mail labelled
   * in Gmail's own sidebar. Nothing on Sorted depends on either.
   */
  const applyMutation = useMutation({
    mutationFn: async () => {
      // Save first: apply materialises whatever is saved, so applying without saving would build
      // the old shape and quietly discard what is on screen.
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
        Your mail already knows what it is about. This decides how it is arranged — put the levels
        in the order you want and see the tree it makes. Every arrangement stays available on
        Sorted; this one is just where that screen opens.
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
          disabled={saveMutation.isPending || effectiveOrder.length === 0 || !changed}
          onClick={() => saveMutation.mutate()}
        >
          {saveMutation.isPending ? 'Saving…' : 'Save as my default'}
        </button>
        {effectiveOrder.length > 0 ? (
          <Link
            className="button"
            to={`/sorted?order=${encodeURIComponent(pivotOrderKey(effectiveOrder))}`}
          >
            Open this arrangement
          </Link>
        ) : null}
      </div>

      {saveMutation.isError ? <ErrorNotice error={saveMutation.error} /> : null}
      {saveMutation.isSuccess && !changed ? (
        <p className="notice" role="status">
          Saved. Sorted opens on this arrangement now — the others are still one click away.
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
            <span>{formatCount(viewQuery.data.unfiled.total)} staying in the inbox</span>
            {/* The split is what makes the floor tunable: mail below the threshold comes back by
                lowering it, mail with no facet value does not. */}
            <span>
              {formatCount(viewQuery.data.unfiled.belowThreshold)} of them just below the floor
            </span>
          </p>
        </>
      ) : null}

      {/*
        Optional, and off unless it was turned on. MailMind is the folder view; labelling Gmail
        buys organisation visible inside the Gmail app and costs a nested label per folder and one
        modify per message. Only this arrangement can be exported — a message wears one Gmail label
        and no more, which is the constraint that used to make "canonical" a real word here.
      */}
      <details className="export">
        <summary>Also mirror this into Gmail</summary>
        <p className="screen__hint">
          MailMind does not need Gmail labels: a message opens by id whether it is filed, archived
          or still in the inbox. Mirroring adds the folders to Gmail&rsquo;s own sidebar, and only
          this arrangement can be mirrored — a message wears one Gmail label and no more. It is off
          unless your MailMind server was configured to allow it.
        </p>
        <div className="screen__actions">
          <button
            className="button"
            type="button"
            disabled={applyMutation.isPending || effectiveOrder.length === 0}
            onClick={() => applyMutation.mutate()}
          >
            {applyMutation.isPending ? 'Creating folders…' : 'Create the folders in Gmail'}
          </button>
          <button
            className="button"
            type="button"
            disabled={fileMutation.isPending}
            onClick={() => fileMutation.mutate()}
          >
            {fileMutation.isPending ? 'Starting…' : 'Label my mail'}
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
            Labelling started. It runs in the background — watch it on Activity.
          </p>
        ) : null}
      </details>
    </section>
  );
}
