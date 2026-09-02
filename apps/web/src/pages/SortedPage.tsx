import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, Search } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';

import { ErrorNotice } from '@web/components/app/ErrorNotice';
import { FolderTile } from '@web/components/app/FolderTile';
import { MailList } from '@web/components/app/MailList';
import { EmptyState, LoadingState } from '@web/components/app/StateViews';
import { formatCount } from '@web/lib/format';
import { queryKeys } from '@web/queries/queryKeys';
import { api } from '@web/services/http';
import {
  PIVOT_PRESETS,
  DEFAULT_EMAIL_TIME_RANGE,
  EMAIL_TIME_RANGE_LABELS,
  EMAIL_TIME_RANGES,
  isEmailTimeRange,
  pivotOrderKey,
  pivotOrderLabel,
  type EmailTimeRange,
  type PivotFacet,
  type PivotNode,
} from '@web/types/facets';

/**
 * The folder view, read straight from the facets — and now every ordering of them at once.
 *
 * It used to read `user_labels` and ask for the mail in a folder by row id, an endpoint that was
 * never built. Then it read one ordering: the canonical one, the only one that could exist,
 * because a message carries one MailMind label and no more.
 *
 * That limit was Gmail's. With Gmail out of the write path it is gone, and `buildPivot` is a pure
 * function of `message_facets`, so `Netflix > Payment failed` and `Finance > Payment failed >
 * Netflix` stopped being a choice. They are two views of the same rows: switching costs no
 * reclassification, no Gmail call, and nothing to apply. The saved ordering is only which one this
 * screen opens on.
 */

/** One level at a time. Folders are nested by their parent's facet key. */
const TOP_FOLDER_LIMIT = 10;

function childrenOf(nodes: PivotNode[], parentFacetKey: string | null): PivotNode[] {
  return nodes
    .filter((node) => node.parentFacetKey === parentFacetKey)
    .sort(
      (left, right) =>
        (right.latestReceivedAt ?? '').localeCompare(left.latestReceivedAt ?? '') ||
        right.subtreeMessageCount - left.subtreeMessageCount ||
        left.fullPath.localeCompare(right.fullPath),
    );
}

function readStoredTimeRange(): EmailTimeRange {
  try {
    const stored = window.localStorage.getItem('mailmind_time_range');
    return isEmailTimeRange(stored) ? stored : DEFAULT_EMAIL_TIME_RANGE;
  } catch {
    return DEFAULT_EMAIL_TIME_RANGE;
  }
}

/** The path back to the top, built by walking parent keys. */
function trailTo(nodes: PivotNode[], facetKey: string | null): PivotNode[] {
  const byKey = new Map(nodes.map((node) => [node.facetKey, node]));
  const trail: PivotNode[] = [];
  let current = facetKey ? byKey.get(facetKey) : undefined;
  while (current) {
    trail.unshift(current);
    current = current.parentFacetKey ? byKey.get(current.parentFacetKey) : undefined;
  }
  return trail;
}

/** `entity,intent` back into an ordering, ignoring anything that is not a facet. */
function parseOrder(value: string | null): PivotFacet[] | null {
  if (!value) return null;
  const parsed = value
    .split(',')
    .map((part) => part.trim())
    .filter(
      (part): part is PivotFacet => part === 'entity' || part === 'domain' || part === 'intent',
    );
  return parsed.length > 0 ? parsed : null;
}

export function SortedPage() {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const facetKey = params.get('folder');
  const [search, setSearch] = useState('');
  const [storedTimeRange, setStoredTimeRange] = useState<EmailTimeRange>(readStoredTimeRange);
  const rangeParam = params.get('range');
  const timeRange: EmailTimeRange = isEmailTimeRange(rangeParam) ? rangeParam : storedTimeRange;

  const settingsQuery = useQuery({
    queryKey: queryKeys.pivotSettings,
    queryFn: () => api.getPivotSettings(),
  });

  // The ordering lives in the URL, so a view is a link. The saved default is where the screen
  // starts, not what it is limited to.
  // Memoised because it is a dependency below, and a fresh `[]` on every render would rebuild the
  // list of arrangements each time.
  const saved = useMemo(
    () => settingsQuery.data?.canonicalPivot ?? [],
    [settingsQuery.data?.canonicalPivot],
  );
  const order = parseOrder(params.get('order')) ?? saved;

  const minMessages = settingsQuery.data?.minMessages;
  const viewQuery = useQuery({
    queryKey: [...queryKeys.pivotView(order, timeRange), minMessages ?? null],
    queryFn: () => api.getPivotView(order, minMessages, timeRange),
    /*
     * The ordering can come from the URL, so it is known before the settings are. Waiting for them
     * anyway keeps the floor out of the first request — otherwise a shared link fetches the tree
     * once at the server default and again at the account's, and the two can differ.
     */
    enabled: order.length > 0 && !settingsQuery.isPending,
  });
  const connectionQuery = useQuery({
    queryKey: queryKeys.gmailConnection,
    queryFn: () => api.getGmailStatus(),
  });

  const saveDefault = useMutation({
    mutationFn: () =>
      api.setPivotSettings({
        canonicalPivot: order,
        ...(settingsQuery.data ? { minMessages: settingsQuery.data.minMessages } : {}),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.pivotSettings }),
  });

  const nodes = useMemo(() => viewQuery.data?.nodes ?? [], [viewQuery.data]);
  const trail = useMemo(() => trailTo(nodes, facetKey), [nodes, facetKey]);
  const current = trail.at(-1) ?? null;
  const term = search.trim().toLowerCase();

  // Searching looks through the whole tree, not just the level in view: a folder you remember by
  // name should not require retracing the path you filed it under.
  const visible = useMemo(() => {
    const level = childrenOf(nodes, current?.facetKey ?? null);
    if (!term) return level.slice(0, TOP_FOLDER_LIMIT);
    return nodes
      .filter((node) => node.leafName.toLowerCase().includes(term))
      .sort((left, right) => left.fullPath.localeCompare(right.fullPath));
  }, [nodes, current, term]);

  const openFolder = (key: string | null) => {
    setSearch('');
    const next = new URLSearchParams(params);
    if (key) next.set('folder', key);
    else next.delete('folder');
    setParams(next, { replace: false });
  };

  /*
   * A facet key names a combination in one particular ordering, so it means nothing in another.
   * Switching therefore returns to the top rather than carrying a key that would resolve to no
   * folder and show an empty screen.
   */
  const switchOrder = (next: PivotFacet[]) => {
    setSearch('');
    setParams({ order: pivotOrderKey(next) }, { replace: false });
  };

  const switchTimeRange = (next: EmailTimeRange) => {
    setSearch('');
    setStoredTimeRange(next);
    try {
      window.localStorage.setItem('mailmind_time_range', next);
    } catch {
      // A blocked storage area should not prevent changing the current view.
    }
    const nextParams = new URLSearchParams(params);
    nextParams.set('range', next);
    nextParams.delete('folder');
    setParams(nextParams, { replace: false });
  };

  // Whatever is saved belongs among the choices even when it is not one of the presets.
  const orderings = useMemo(() => {
    const presets = PIVOT_PRESETS.map((preset) => preset.order);
    const known = new Set(presets.map(pivotOrderKey));
    return saved.length > 0 && !known.has(pivotOrderKey(saved)) ? [saved, ...presets] : presets;
  }, [saved]);

  const isSaved = saved.length > 0 && pivotOrderKey(order) === pivotOrderKey(saved);
  const loading = settingsQuery.isPending || viewQuery.isPending;

  return (
    <section className="screen">
      <header className="screen__head">
        <h1 className="screen__title">Sorted</h1>
        <label className="search">
          <Search aria-hidden="true" strokeWidth={1.5} />
          <input
            type="search"
            value={search}
            placeholder="Search folders"
            aria-label="Search folders"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </header>

      <div className="sorted__filters">
        <label className="time-range">
          <span>Show mail from</span>
          <select
            aria-label="Show mail from"
            value={timeRange}
            onChange={(event) => {
              if (isEmailTimeRange(event.target.value)) switchTimeRange(event.target.value);
            }}
          >
            {EMAIL_TIME_RANGES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {EMAIL_TIME_RANGE_LABELS[candidate]}
              </option>
            ))}
          </select>
        </label>
        <span className="sorted__scope">
          Showing the {timeRange === 'all' ? 'full' : 'most recent'} matching mailbox
        </span>
      </div>

      {/* Every arrangement of the same mail, side by side. None of them is the real one. */}
      <nav className="ordering" aria-label="Folder arrangement">
        {orderings.map((candidate) => {
          const key = pivotOrderKey(candidate);
          const isCurrent = key === pivotOrderKey(order);
          return (
            <button
              key={key}
              type="button"
              className={`ordering__option${isCurrent ? ' ordering__option--active' : ''}`}
              aria-current={isCurrent ? 'true' : undefined}
              onClick={() => switchOrder(candidate)}
            >
              <span className="ordering__label">{pivotOrderLabel(candidate)}</span>
              {key === pivotOrderKey(saved) ? (
                <span className="ordering__badge">
                  <Check aria-hidden="true" strokeWidth={2} /> Default
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>
      <p className="screen__hint">
        Same mail, arranged differently. Switching changes nothing about your mailbox — these are
        views of what your mail already says about itself.{' '}
        {!isSaved && order.length > 0 ? (
          <button
            type="button"
            className="button button--quiet"
            disabled={saveDefault.isPending}
            onClick={() => saveDefault.mutate()}
          >
            {saveDefault.isPending ? 'Saving…' : 'Make this my default'}
          </button>
        ) : null}
      </p>
      {saveDefault.isError ? <ErrorNotice error={saveDefault.error} /> : null}

      {trail.length > 0 && !term ? (
        <nav className="crumbs" aria-label="Folder path">
          <button type="button" className="crumbs__link" onClick={() => openFolder(null)}>
            All folders
          </button>
          {trail.map((folder, index) => (
            <span className="crumbs__step" key={folder.facetKey}>
              <ChevronRight aria-hidden="true" strokeWidth={1.5} />
              {index === trail.length - 1 ? (
                <span aria-current="page">{folder.leafName}</span>
              ) : (
                <button
                  type="button"
                  className="crumbs__link"
                  onClick={() => openFolder(folder.facetKey)}
                >
                  {folder.leafName}
                </button>
              )}
            </span>
          ))}
        </nav>
      ) : null}

      {loading ? <LoadingState label="Loading folders" /> : null}
      {viewQuery.isError ? (
        <ErrorNotice
          error={viewQuery.error}
          title="Folders could not be loaded"
          onRetry={() => void viewQuery.refetch()}
        />
      ) : null}

      {!loading && nodes.length === 0 ? (
        /*
         * An empty screen has to name the step that is actually missing. This used to point at
         * Approve, which is where a fresh account got a 409.
         */
        connectionQuery.data && !connectionQuery.data.connected ? (
          <EmptyState
            title="Connect your mailbox"
            description="Nothing can be sorted until MailMind can read your mail. It takes about a minute."
            action={
              <Link className="button button--primary" to="/setup">
                Set up MailMind
              </Link>
            }
          />
        ) : (
          <EmptyState
            title="No folders at this arrangement"
            description="Your mail has not been sorted into facets yet, or every group here is below the folder floor. Another arrangement above may have more."
            action={
              <Link className="button button--primary" to="/folders">
                Shape my folders
              </Link>
            }
          />
        )
      ) : null}

      {visible.length > 0 ? (
        <div className="tile-grid">
          {visible.map((folder) => (
            <FolderTile
              key={folder.facetKey}
              name={folder.leafName}
              path={folder.fullPath}
              count={folder.isLeaf ? folder.messageCount : folder.subtreeMessageCount}
              childCount={childrenOf(nodes, folder.facetKey).length}
              onOpen={() => openFolder(folder.facetKey)}
            />
          ))}
        </div>
      ) : null}

      {term && visible.length === 0 && nodes.length > 0 ? (
        <EmptyState title="No folder matches" description={`Nothing is named like "${search}".`} />
      ) : null}

      {/* What this arrangement leaves out, so the tail is visible rather than merely absent. */}
      {viewQuery.data && !current && !term ? (
        <p className="plan-meta">
          <span>{formatCount(viewQuery.data.nodes.length)} folders</span>
          <span>{formatCount(viewQuery.data.unfiled.total)} still in the inbox</span>
          <span>
            {formatCount(viewQuery.data.unfiled.belowThreshold)} of them just below the floor
          </span>
        </p>
      ) : null}

      {current && !term ? (
        <FolderMessages
          folder={current}
          connectedEmail={connectionQuery.data?.email ?? null}
          range={timeRange}
        />
      ) : null}
    </section>
  );
}

function FolderMessages({
  folder,
  connectedEmail,
  range,
}: {
  folder: PivotNode;
  connectedEmail: string | null;
  range: EmailTimeRange;
}) {
  const messagesQuery = useQuery({
    queryKey: queryKeys.facetMessages(folder.facetKey, range),
    queryFn: () => api.getFacetMessages(folder.facetKey, { range }),
  });

  if (messagesQuery.isPending) return <LoadingState label="Loading mail" />;
  if (messagesQuery.isError) {
    return (
      <ErrorNotice
        error={messagesQuery.error}
        title={`Mail in ${folder.leafName} could not be loaded`}
        onRetry={() => void messagesQuery.refetch()}
      />
    );
  }

  const { messages, total } = messagesQuery.data;
  if (messages.length === 0) {
    return (
      <EmptyState
        title="Nothing here yet"
        description="No message carries this combination of facets."
      />
    );
  }

  return (
    <>
      {/* Opening a parent asks "everything under here", so the count is the whole subtree. */}
      <p className="screen__hint">
        {total} message{total === 1 ? '' : 's'} in {folder.leafName}
        {messages.length < total ? `, showing the newest ${messages.length}` : ''}
      </p>
      <MailList messages={messages} connectedEmail={connectedEmail} />
    </>
  );
}
