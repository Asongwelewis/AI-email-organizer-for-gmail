import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ErrorNotice } from '@web/components/app/ErrorNotice';
import { EmptyState, LoadingState } from '@web/components/app/StateViews';
import { formatCount } from '@web/lib/format';
import { folderColor } from '@web/lib/folderColor';
import { queryKeys } from '@web/queries/queryKeys';
import { api } from '@web/services/http';
import type { TaxonomyPlanNode } from '@web/types/labels';

/**
 * Dropping a folder drops everything beneath it. A child cannot be created without its parent, so
 * a subtree whose root was unchecked cannot quietly survive by way of one of its children.
 */
function keptNodes(nodes: TaxonomyPlanNode[], excluded: Set<string>): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const kept = new Set<string>();
  for (const node of nodes) {
    let current: TaxonomyPlanNode | undefined = node;
    let survives = true;
    while (current) {
      if (excluded.has(current.id)) {
        survives = false;
        break;
      }
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    if (survives) kept.add(node.id);
  }
  return kept;
}

export function ApprovePage() {
  const queryClient = useQueryClient();
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  const labelsQuery = useQuery({
    queryKey: queryKeys.labels,
    queryFn: () => api.getLabels(),
  });
  const plan = labelsQuery.data?.plan ?? null;

  const proposeMutation = useMutation({
    mutationFn: () => api.proposeLabels(),
    onSuccess: (overview) => {
      setExcluded(new Set());
      queryClient.setQueryData(queryKeys.labels, overview);
    },
  });

  const approveMutation = useMutation({
    mutationFn: (input: { planId: string; nodeIds?: string[] }) => api.approvePlan(input),
    onSuccess: (overview) => {
      setExcluded(new Set());
      queryClient.setQueryData(queryKeys.labels, overview);
      void queryClient.invalidateQueries({ queryKey: queryKeys.activityRuns });
    },
  });

  const nodes = useMemo(() => plan?.nodes ?? [], [plan]);
  const keptIds = useMemo(() => keptNodes(nodes, excluded), [nodes, excluded]);
  const keptLeaves = nodes.filter((node) => node.isLeaf && keptIds.has(node.id)).length;

  const toggle = (node: TaxonomyPlanNode) => {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
  };

  return (
    <section className="screen">
      <header className="screen__head">
        <h1 className="screen__title">Approve</h1>
        <button
          className="button"
          type="button"
          onClick={() => proposeMutation.mutate()}
          disabled={proposeMutation.isPending}
        >
          {proposeMutation.isPending ? 'Planning…' : plan ? 'Propose again' : 'Propose folders'}
        </button>
      </header>

      <p className="screen__lede">
        One planning pass reads a sample of your mail and designs a folder tree. Nothing is created
        in Gmail until you approve it here.
      </p>

      {/* Inline, never a toast: a failure has to stay on screen with the code that caused it. */}
      {proposeMutation.isError ? (
        <ErrorNotice error={proposeMutation.error} title="The planning run failed" />
      ) : null}
      {approveMutation.isError ? (
        <ErrorNotice error={approveMutation.error} title="Approval failed" />
      ) : null}
      {labelsQuery.isError ? (
        <ErrorNotice
          error={labelsQuery.error}
          title="The proposal could not be loaded"
          onRetry={() => void labelsQuery.refetch()}
        />
      ) : null}

      {labelsQuery.isPending ? <LoadingState label="Loading proposal" /> : null}

      {/* A proposal that produced nothing says so. It is not a success with an empty list. */}
      {labelsQuery.isSuccess && !plan ? (
        <EmptyState
          title="No proposal waiting"
          description="Run a planning pass to see a folder tree with counts before anything is created in Gmail."
        />
      ) : null}
      {plan && nodes.length === 0 ? (
        <EmptyState
          title="The planner proposed no folders"
          description="Nothing in the sample supported a folder worth creating. Synchronize more mail, then plan again."
        />
      ) : null}

      {plan && nodes.length > 0 ? (
        <>
          <dl className="plan-meta">
            <div>
              <dt>Sampled</dt>
              <dd>{formatCount(plan.sampledMessageCount)}</dd>
            </div>
            <div>
              <dt>Of</dt>
              <dd>{formatCount(plan.analyzedMessageCount)}</dd>
            </div>
            <div>
              <dt>Folders kept</dt>
              <dd>{formatCount(keptLeaves)}</dd>
            </div>
          </dl>

          <ul className="plan-tree">
            {nodes.map((node) => {
              const color = folderColor(node.path);
              const kept = keptIds.has(node.id);
              return (
                <li
                  key={node.id}
                  className={`plan-node plan-node--depth-${node.depth}${kept ? '' : ' plan-node--dropped'}`}
                >
                  <label className="plan-node__main">
                    <input
                      type="checkbox"
                      checked={kept}
                      onChange={() => toggle(node)}
                      aria-label={`Keep ${node.path}`}
                    />
                    {/* Same hue the folder will wear once approved, resolved by the theme. */}
                    <span
                      className="plan-node__name"
                      style={{
                        ['--tile-hue' as string]: String(color.hue),
                        color: 'var(--tile-ink)',
                      }}
                    >
                      {node.name}
                    </span>
                    <span className="plan-node__count">
                      {formatCount(node.rolledUpMessageCount)}
                    </span>
                  </label>
                  <p className="plan-node__rationale">{node.rationale}</p>
                  {node.rules.length > 0 ? (
                    <ul className="plan-node__rules">
                      {node.rules.map((rule) => (
                        <li key={`${rule.kind}:${rule.value}`}>
                          <code>{rule.kind}</code> {rule.value}
                          <span className="plan-node__rule-count">
                            {formatCount(rule.matchedMessageCount)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>

          {/* What the model asked for and did not get. Shown with the tree, not hidden in a log. */}
          {plan.warnings.length > 0 ? (
            <details className="plan-warnings">
              <summary>
                {plan.warnings.length === 1
                  ? '1 suggestion was rejected'
                  : `${plan.warnings.length} suggestions were rejected`}
              </summary>
              <ul>
                {plan.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </details>
          ) : null}

          <div className="screen__actions">
            <button
              className="button button--primary"
              type="button"
              disabled={approveMutation.isPending || keptLeaves === 0}
              onClick={() =>
                approveMutation.mutate({
                  planId: plan.id,
                  ...(excluded.size > 0 ? { nodeIds: [...keptIds] } : {}),
                })
              }
            >
              {approveMutation.isPending ? 'Creating…' : `Approve ${keptLeaves} folders`}
            </button>
            {keptLeaves === 0 ? (
              <p className="screen__hint">Keep at least one folder to approve.</p>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
