import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ExternalLink, Search } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';

import { ErrorNotice } from '@web/components/app/ErrorNotice';
import { FolderTile } from '@web/components/app/FolderTile';
import { EmptyState, LoadingState } from '@web/components/app/StateViews';
import { formatTimestamp } from '@web/lib/format';
import { gmailMessageUrl } from '@web/lib/gmailLink';
import { queryKeys } from '@web/queries/queryKeys';
import { api } from '@web/services/http';
import type { PivotNode } from '@web/types/facets';

/**
 * The folder view, read straight from the facets.
 *
 * It used to read `user_labels` and ask for the mail in a folder by row id — an endpoint that was
 * never built, so opening a folder 404'd and Gmail's own labels were doing all the organising.
 * Now the tree is `buildPivot` over `message_facets` and a folder's contents are the messages
 * matching its combination, so none of this depends on a folder row or on anything ever having
 * been written to Gmail.
 */

/** One level at a time. Folders are nested by their parent's facet key. */
function childrenOf(nodes: PivotNode[], parentFacetKey: string | null): PivotNode[] {
  return nodes
    .filter((node) => node.parentFacetKey === parentFacetKey)
    .sort((left, right) => right.subtreeMessageCount - left.subtreeMessageCount);
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

export function SortedPage() {
  const [params, setParams] = useSearchParams();
  const facetKey = params.get('folder');
  const [search, setSearch] = useState('');

  const settingsQuery = useQuery({
    queryKey: queryKeys.pivotSettings,
    queryFn: () => api.getPivotSettings(),
  });
  const order = settingsQuery.data?.canonicalPivot ?? [];

  const viewQuery = useQuery({
    queryKey: queryKeys.pivotView(order),
    queryFn: () => api.getPivotView(order, settingsQuery.data?.minMessages),
    enabled: order.length > 0,
  });
  const connectionQuery = useQuery({
    queryKey: queryKeys.gmailConnection,
    queryFn: () => api.getGmailStatus(),
  });

  const nodes = useMemo(() => viewQuery.data?.nodes ?? [], [viewQuery.data]);
  const trail = useMemo(() => trailTo(nodes, facetKey), [nodes, facetKey]);
  const current = trail.at(-1) ?? null;
  const term = search.trim().toLowerCase();

  // Searching looks through the whole tree, not just the level in view: a folder you remember by
  // name should not require retracing the path you filed it under.
  const visible = useMemo(() => {
    const level = childrenOf(nodes, current?.facetKey ?? null);
    if (!term) return level;
    return nodes
      .filter((node) => node.leafName.toLowerCase().includes(term))
      .sort((left, right) => left.fullPath.localeCompare(right.fullPath));
  }, [nodes, current, term]);

  const openFolder = (key: string | null) => {
    setSearch('');
    setParams(key ? { folder: key } : {}, { replace: false });
  };

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
            title="No folders yet"
            description="Your mail has not been sorted into facets yet, or every group is below the folder floor."
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

      {current && !term ? (
        <FolderMessages folder={current} connectedEmail={connectionQuery.data?.email ?? null} />
      ) : null}
    </section>
  );
}

function FolderMessages({
  folder,
  connectedEmail,
}: {
  folder: PivotNode;
  connectedEmail: string | null;
}) {
  const messagesQuery = useQuery({
    queryKey: queryKeys.facetMessages(folder.facetKey),
    queryFn: () => api.getFacetMessages(folder.facetKey),
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
      <ul className="mail-list">
        {messages.map((message) => (
          <li key={message.id}>
            {/* Straight into Gmail. MailMind never renders message bodies. The link addresses the
                message by id, so it resolves whether or not the message carries any label. */}
            <a
              className="mail-row"
              href={gmailMessageUrl(connectedEmail, message.gmailMessageId)}
              target="_blank"
              rel="noreferrer noopener"
            >
              <span className="mail-row__from">{message.senderName ?? message.senderEmail}</span>
              <span className="mail-row__subject">{message.subject ?? 'No subject'}</span>
              <span className="mail-row__date">
                {message.receivedAt ? formatTimestamp(message.receivedAt) : '—'}
              </span>
              <ExternalLink className="mail-row__open" aria-hidden="true" strokeWidth={1.5} />
              <span className="sr-only">Open in Gmail</span>
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}
