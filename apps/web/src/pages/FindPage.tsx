import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';

import { ErrorNotice } from '@web/components/app/ErrorNotice';
import { MailList } from '@web/components/app/MailList';
import { EmptyState, LoadingState } from '@web/components/app/StateViews';
import { formatCount } from '@web/lib/format';
import { queryKeys } from '@web/queries/queryKeys';
import { api } from '@web/services/http';
import { FACET_LABELS, type PivotFacet, type SearchFilters } from '@web/types/facets';

/**
 * Find the email you lost.
 *
 * Folders are half of findability and this is the other half. With Gmail out of the write path,
 * `label:` is no longer the mechanism, so the search has to live here — over subject and sender
 * across the whole mailbox, not the folder that happens to be open.
 *
 * The facet filters are the part a Gmail label tree cannot do at all. `intent=payment-failed`
 * across every brand at once is a question no single tree can be arranged to answer, because a
 * tree expresses one ordering of the facets and this asks about another. Combining them is free:
 * they are three columns on the same row.
 *
 * Nothing here spends anything. No model call, no Gmail call — Postgres full text over metadata
 * the sync already stored.
 */

/** The filterable facets, in the order they read as a sentence: brand, area, intent. */
const FILTERS: PivotFacet[] = ['entity', 'domain', 'intent'];

/** `payment-failed` reads as `Payment failed`, the same way a folder name does. */
function readableValue(value: string): string {
  const spaced = value.replace(/-+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Waits for the typing to stop before asking.
 *
 * Every keystroke is a query otherwise, and the interesting searches here are long ones — a
 * half-remembered subject line is a sentence, not a word.
 */
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

export function FindPage() {
  const [params, setParams] = useSearchParams();
  // The search lives in the URL, so a search worth keeping is a link — the same reason an
  // ordering is. Typing is local until it settles, or the history would grow a step per keystroke.
  const [typed, setTyped] = useState(() => params.get('q') ?? '');
  const query = useDebounced(typed, 300);

  const filters: SearchFilters = useMemo(() => {
    const entity = params.get('entity');
    const domain = params.get('domain');
    const intent = params.get('intent');
    const unread = params.get('unread') === 'true';
    return {
      ...(entity ? { entity } : {}),
      ...(domain ? { domain } : {}),
      ...(intent ? { intent } : {}),
      ...(unread ? { unread } : {}),
    };
  }, [params]);
  const active = Boolean(
    query.trim() || filters.entity || filters.domain || filters.intent || filters.unread,
  );

  useEffect(() => {
    const next = new URLSearchParams(params);
    if (query.trim()) next.set('q', query.trim());
    else next.delete('q');
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
  }, [query, params, setParams]);

  const vocabularyQuery = useQuery({
    queryKey: queryKeys.facetVocabulary,
    queryFn: () => api.getFacetVocabulary(),
  });
  const connectionQuery = useQuery({
    queryKey: queryKeys.gmailConnection,
    queryFn: () => api.getGmailStatus(),
  });

  const resultsQuery = useInfiniteQuery({
    queryKey: queryKeys.facetSearch(query.trim(), filters, []),
    queryFn: ({ pageParam }) =>
      api.searchMessages(query.trim(), filters, pageParam ? { cursor: pageParam as string } : {}),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // A search that constrains nothing is the mailbox, and the API refuses it. Do not ask.
    enabled: active,
  });

  const pages = resultsQuery.data?.pages ?? [];
  const hits = pages.flatMap((page) => page.results);
  const total = pages[0]?.total ?? 0;

  const setFilter = (facet: PivotFacet, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(facet, value);
    else next.delete(facet);
    setParams(next, { replace: false });
  };

  const clear = () => {
    setTyped('');
    setParams({}, { replace: false });
  };

  return (
    <section className="screen">
      <header className="screen__head">
        <h1 className="screen__title">Find</h1>
        <label className="search">
          <Search aria-hidden="true" strokeWidth={1.5} />
          <input
            type="search"
            value={typed}
            placeholder="Subject or sender"
            aria-label="Search your mail"
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
      </header>
      <p className="screen__lede">
        Everything MailMind knows about your mail, searchable at once. Half a subject line, a brand,
        or just what the message wanted — a failed payment from some streaming service is a question
        folders alone cannot answer.
      </p>

      <div className="facet-filters">
        {FILTERS.map((facet) => (
          <label className="facet-filter" key={facet}>
            <span className="facet-filter__label">{FACET_LABELS[facet]}</span>
            <select
              value={filters[facet] ?? ''}
              onChange={(event) => setFilter(facet, event.target.value)}
            >
              <option value="">Any</option>
              {(vocabularyQuery.data?.[facet] ?? []).map((value) => (
                <option key={value.value} value={value.value}>
                  {readableValue(value.value)}
                  {value.messageCount > 0 ? ` (${formatCount(value.messageCount)})` : ''}
                </option>
              ))}
            </select>
          </label>
        ))}
        {/*
          Unread on its own is a whole search: "what has arrived that I have not read", newest
          first, each hit carrying the folder it landed in. It needs no phrase, which is why the
          API treats it as a constraint in its own right.
        */}
        <button
          type="button"
          className={`button${filters.unread ? ' button--primary' : ''}`}
          aria-pressed={filters.unread === true}
          onClick={() => {
            const next = new URLSearchParams(params);
            if (filters.unread) next.delete('unread');
            else next.set('unread', 'true');
            setParams(next, { replace: false });
          }}
        >
          Only new mail
        </button>
        {active ? (
          <button type="button" className="button button--quiet" onClick={clear}>
            Clear
          </button>
        ) : null}
      </div>

      {vocabularyQuery.isError ? (
        <ErrorNotice
          error={vocabularyQuery.error}
          title="The filters could not be loaded"
          onRetry={() => void vocabularyQuery.refetch()}
        />
      ) : null}

      {!active ? (
        <EmptyState
          title="Search your whole mailbox"
          description="Type part of a subject or a sender, pick a filter, or press Only new mail to see everything unread, newest first, with the folder it landed in."
          action={
            <Link className="button button--quiet" to="/sorted">
              Browse folders instead
            </Link>
          }
        />
      ) : null}

      {active && resultsQuery.isPending ? <LoadingState label="Searching" /> : null}
      {resultsQuery.isError ? (
        <ErrorNotice
          error={resultsQuery.error}
          title="That search could not be run"
          onRetry={() => void resultsQuery.refetch()}
        />
      ) : null}

      {active && resultsQuery.isSuccess ? (
        hits.length === 0 ? (
          <EmptyState
            title="Nothing matches"
            description="No message in this mailbox carries that subject, sender, or combination of facets."
          />
        ) : (
          <>
            <p className="screen__hint">
              {formatCount(total)} {filters.unread ? 'unread ' : ''}message{total === 1 ? '' : 's'}
              {', newest first'}
              {hits.length < total ? `, showing the newest ${formatCount(hits.length)}` : ''}
            </p>
            {/* Every hit carries the folder it sits in: "it was under Finance all along" is half
                of what a person was actually asking. */}
            <MailList messages={hits} connectedEmail={connectionQuery.data?.email ?? null} />
            {resultsQuery.hasNextPage ? (
              <div className="screen__actions">
                <button
                  type="button"
                  className="button"
                  disabled={resultsQuery.isFetchingNextPage}
                  onClick={() => void resultsQuery.fetchNextPage()}
                >
                  {resultsQuery.isFetchingNextPage ? 'Loading…' : 'Show older'}
                </button>
              </div>
            ) : null}
          </>
        )
      ) : null}
    </section>
  );
}
