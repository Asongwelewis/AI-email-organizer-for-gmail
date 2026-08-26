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
import type { UserLabel } from '@web/types/labels';

/** Folders are nested by parentId; the grid only ever shows one level at a time. */
function childrenOf(labels: UserLabel[], parentId: string | null): UserLabel[] {
  return labels
    .filter((label) => label.parentId === parentId)
    .sort((left, right) => left.leafName.localeCompare(right.leafName));
}

function trailTo(labels: UserLabel[], folderId: string | null): UserLabel[] {
  const byId = new Map(labels.map((label) => [label.id, label]));
  const trail: UserLabel[] = [];
  let current = folderId ? byId.get(folderId) : undefined;
  while (current) {
    trail.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return trail;
}

export function SortedPage() {
  const [params, setParams] = useSearchParams();
  const folderId = params.get('folder');
  const [search, setSearch] = useState('');

  const labelsQuery = useQuery({
    queryKey: queryKeys.labels,
    queryFn: () => api.getLabels(),
  });
  const connectionQuery = useQuery({
    queryKey: queryKeys.gmailConnection,
    queryFn: () => api.getGmailStatus(),
  });

  const labels = useMemo(() => labelsQuery.data?.labels ?? [], [labelsQuery.data]);
  const trail = useMemo(() => trailTo(labels, folderId), [labels, folderId]);
  const current = trail.at(-1) ?? null;
  const term = search.trim().toLowerCase();

  // Searching looks through the whole tree, not just the level in view: a folder you remember by
  // name should not require retracing the path you filed it under.
  const visible = useMemo(() => {
    const level = childrenOf(labels, current?.id ?? null);
    if (!term) return level;
    return labels
      .filter((label) => label.leafName.toLowerCase().includes(term))
      .sort((left, right) => left.path.localeCompare(right.path));
  }, [labels, current, term]);

  const openFolder = (id: string | null) => {
    setSearch('');
    setParams(id ? { folder: id } : {}, { replace: false });
  };

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
            <span className="crumbs__step" key={folder.id}>
              <ChevronRight aria-hidden="true" strokeWidth={1.5} />
              {index === trail.length - 1 ? (
                <span aria-current="page">{folder.leafName}</span>
              ) : (
                <button
                  type="button"
                  className="crumbs__link"
                  onClick={() => openFolder(folder.id)}
                >
                  {folder.leafName}
                </button>
              )}
            </span>
          ))}
        </nav>
      ) : null}

      {labelsQuery.isPending ? <LoadingState label="Loading folders" /> : null}
      {labelsQuery.isError ? (
        <ErrorNotice
          error={labelsQuery.error}
          title="Folders could not be loaded"
          onRetry={() => void labelsQuery.refetch()}
        />
      ) : null}

      {labelsQuery.isSuccess && labels.length === 0 ? (
        /*
         * This used to point at Approve, which is precisely where a fresh account got a 409: no
         * Gmail connected and no mail synced. An empty screen has to name the step that is
         * actually missing, so it sends people where the work is.
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
            description="Your mail is read but not arranged. Choose how it should be grouped and apply it."
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
              key={folder.id}
              name={folder.leafName}
              path={folder.path}
              count={folder.messageCount ?? null}
              childCount={childrenOf(labels, folder.id).length}
              onOpen={() => openFolder(folder.id)}
            />
          ))}
        </div>
      ) : null}

      {term && visible.length === 0 && labels.length > 0 ? (
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
  folder: UserLabel;
  connectedEmail: string | null;
}) {
  const messagesQuery = useQuery({
    queryKey: queryKeys.folderMessages(folder.id),
    queryFn: () => api.getFolderMessages(folder.id),
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

  const messages = messagesQuery.data.messages;
  if (messages.length === 0) {
    return (
      <EmptyState
        title="Nothing filed here yet"
        description="Mail lands in this folder the next time a filing run matches it."
      />
    );
  }

  return (
    <ul className="mail-list">
      {messages.map((message) => (
        <li key={message.id}>
          {/* Straight into Gmail. MailMind never renders message bodies; it only files them. */}
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
  );
}
