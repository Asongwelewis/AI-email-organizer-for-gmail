import { Prisma } from '@prisma/client';

import { prisma } from '@api/database/prisma.js';
import { AppError } from '@api/errors/AppError.js';
import {
  facetVocabularyRepository,
  type FacetVocabularyRepository,
} from '@api/features/label-discovery/facet-vocabulary.repository.js';
import { buildPivot, pivotLeafFor, type PivotFacet } from '@api/features/label-discovery/pivot.js';
import { pivotService, type PivotService } from '@api/features/labels/pivot.service.js';

/**
 * Search that finds the one email.
 *
 * Folders are half of findability. The other half is the message you can only half remember — the
 * failed payment from some streaming service, the subject line you nearly recall — and with Gmail
 * out of the write path, `label:` is no longer the mechanism that answers it. This is, out of the
 * metadata already stored: subject, sender, and the three facets.
 *
 * Two things a Gmail label tree cannot do, and this can. `intent=payment-failed` across every
 * brand at once, because facets are orthogonal and a tree can only express one ordering of them.
 * And a subject fragment matched against the whole mailbox rather than one folder at a time.
 *
 * No model call and no Gmail call — Postgres full text over columns the sync already wrote. The
 * boundary is unchanged: there is no body here to search and there never will be.
 */

/** The lexemes a message is searchable by. Must stay identical to the index expression. */
const SEARCHABLE = Prisma.sql`
  to_tsvector(
    'simple',
    coalesce(m.subject, '') || ' ' ||
    coalesce(m.sender_name, '') || ' ' ||
    translate(coalesce(m.sender_email, ''), '@._-', '    ')
  )
`;

export interface SearchFilters {
  entity?: string;
  domain?: string;
  intent?: string;
  /** Only mail still unread in Gmail. On its own it is "what arrived that I have not seen". */
  unread?: boolean;
}

export interface SearchHit {
  id: string;
  gmailMessageId: string;
  subject: string | null;
  senderName: string | null;
  senderEmail: string | null;
  snippet: string | null;
  receivedAt: string | null;
  isUnread: boolean;
  entity: string | null;
  domain: string | null;
  intent: string | null;
  /**
   * Which folder this message sits in under the ordering being viewed. Null when it sits in none —
   * unclassified, or in a combination too small to have become one.
   */
  folder: { facetKey: string; fullPath: string; leafName: string } | null;
}

export interface SearchResult {
  query: string | null;
  filters: { entity: string | null; domain: string | null; intent: string | null; unread: boolean };
  order: PivotFacet[];
  results: SearchHit[];
  total: number;
  nextCursor: string | null;
}

export interface FacetVocabulary {
  /** The brands in this mailbox, commonest first. Derived from senders, so it is per-account. */
  entity: Array<{ value: string; messageCount: number }>;
  /** The two closed vocabularies, which are the same for every account until card 28. */
  domain: Array<{ value: string; messageCount: number }>;
  intent: Array<{ value: string; messageCount: number }>;
}

/** Rows as the search query returns them, before the folder is resolved onto each. */
interface SearchRow {
  id: string;
  gmail_message_id: string;
  subject: string | null;
  sender_name: string | null;
  sender_email: string | null;
  snippet: string | null;
  internal_date: Date | null;
  is_unread: boolean;
  entity: string | null;
  domain: string | null;
  intent: string | null;
}

/**
 * The same punctuation split the index applies to an address, applied to what a person typed.
 *
 * Without it, searching for `billing@netflix.com` would build one `email` token that matches
 * nothing, because the indexed side was already split into words. With it, the address becomes
 * three lexemes that must all appear — which is what someone pasting an address means.
 */
function searchTerms(query: string): string {
  return query.replace(/[@._-]+/g, ' ');
}

export class MessageSearchService {
  constructor(
    private readonly pivots: PivotService = pivotService,
    private readonly vocabularies: FacetVocabularyRepository = facetVocabularyRepository,
  ) {}

  /**
   * Subject and sender across the whole mailbox, narrowed by any combination of facets.
   *
   * At least one of the four has to be given. A search constraining nothing is not a search — it
   * is the mailbox, and answering it under a "results" heading would be a lie about what was
   * found.
   */
  async search(
    accountId: string,
    query: string | null,
    filters: SearchFilters,
    options: { limit?: number; cursor?: string; order?: PivotFacet[] } = {},
  ): Promise<SearchResult> {
    const trimmed = query?.trim() ?? '';
    if (!trimmed && !filters.entity && !filters.domain && !filters.intent && !filters.unread) {
      throw new AppError(
        'FACET_VALIDATION_FAILED',
        'A search needs a phrase or at least one facet.',
        400,
      );
    }
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

    const conditions = [
      Prisma.sql`m.connected_google_account_id = ${accountId}::uuid`,
      Prisma.sql`m.deleted_at is null`,
    ];
    if (trimmed) {
      conditions.push(
        Prisma.sql`${SEARCHABLE} @@ websearch_to_tsquery('simple', ${searchTerms(trimmed)})`,
      );
    }
    /*
     * Unread on its own is a legitimate whole search: "what has arrived that I have not read",
     * newest first, each hit carrying the folder it landed in. It reads the mailbox mirror, so
     * reading something in Gmail drops it from these results on the next sync.
     */
    if (filters.unread) conditions.push(Prisma.sql`m.is_unread = true`);
    // Facet filters are equality against a closed vocabulary, so they narrow rather than search.
    if (filters.entity) conditions.push(Prisma.sql`f.entity = ${filters.entity}`);
    if (filters.domain) conditions.push(Prisma.sql`f.domain = ${filters.domain}`);
    if (filters.intent) conditions.push(Prisma.sql`f.intent = ${filters.intent}`);

    /*
     * A facet filter constrains the facet row, so it has to join. A phrase-only search must not,
     * or mail that has never been classified would be unfindable — which is exactly the mail
     * somebody is most likely to be hunting for.
     */
    const requiresFacets = Boolean(filters.entity ?? filters.domain ?? filters.intent);
    const join = requiresFacets
      ? Prisma.sql`join public.message_facets f on f.gmail_message_id = m.id`
      : Prisma.sql`left join public.message_facets f on f.gmail_message_id = m.id`;
    const where = Prisma.sql`where ${Prisma.join(conditions, ' and ')}`;

    /*
     * Keyset pagination on (date, id), and `coalesce` because `internal_date` is nullable: a
     * tuple comparison against a null is null, which would silently drop every undated message
     * from the second page onwards.
     */
    const sortKey = Prisma.sql`coalesce(m.internal_date, to_timestamp(0))`;
    const after = options.cursor
      ? Prisma.sql`and (${sortKey}, m.id) < (
          select coalesce(c.internal_date, to_timestamp(0)), c.id
          from public.gmail_message_metadata c
          where c.id = ${options.cursor}::uuid
        )`
      : Prisma.empty;

    const [counted, rows] = await Promise.all([
      prisma.$queryRaw<Array<{ total: bigint }>>`
        select count(*)::bigint as total
        from public.gmail_message_metadata m
        ${join}
        ${where}
      `,
      prisma.$queryRaw<SearchRow[]>`
        select m.id, m.gmail_message_id, m.subject, m.sender_name, m.sender_email, m.snippet,
               m.internal_date, m.is_unread, f.entity, f.domain, f.intent
        from public.gmail_message_metadata m
        ${join}
        ${where}
        ${after}
        order by ${sortKey} desc, m.id desc
        limit ${limit + 1}
      `,
    ]);

    const page = rows.slice(0, limit);
    const folders = await this.folderResolver(accountId, options.order);
    return {
      query: trimmed || null,
      filters: {
        entity: filters.entity ?? null,
        domain: filters.domain ?? null,
        intent: filters.intent ?? null,
        unread: filters.unread === true,
      },
      order: folders.order,
      total: Number(counted[0]?.total ?? 0n),
      // One row beyond the page proves there is more, without a second count.
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      results: page.map((row) => ({
        id: row.id,
        gmailMessageId: row.gmail_message_id,
        subject: row.subject,
        senderName: row.sender_name,
        senderEmail: row.sender_email,
        snippet: row.snippet,
        receivedAt: row.internal_date?.toISOString() ?? null,
        isUnread: row.is_unread,
        entity: row.entity,
        domain: row.domain,
        intent: row.intent,
        folder: folders.locate(row),
      })),
    };
  }

  /**
   * Where each hit sits, under one ordering of the facets.
   *
   * A hit is far more useful with its folder attached — "it was under Finance all along" is half
   * the answer — and `buildPivot` is a pure function of the facet rows, so this costs one read of
   * the same table the folders screen already builds itself from.
   */
  private async folderResolver(accountId: string, order?: PivotFacet[]) {
    const settings = await this.pivots.settings(accountId);
    const pivot = buildPivot(
      await this.pivots.facetedMessages(accountId),
      order ?? settings.canonicalPivot,
      { minMessages: settings.minMessages },
    );
    return {
      order: pivot.order,
      locate(row: {
        gmail_message_id: string;
        entity: string | null;
        domain: string | null;
        intent: string | null;
      }) {
        const node = pivotLeafFor(
          { id: row.gmail_message_id, entity: row.entity, domain: row.domain, intent: row.intent },
          pivot,
        );
        return node
          ? { facetKey: node.facetKey, fullPath: node.fullPath, leafName: node.leafName }
          : null;
      },
    };
  }

  /**
   * What there is to filter by, and how much mail each value holds.
   *
   * `domain` and `intent` come from the vocabulary THIS mailbox approved, so every approved value
   * appears even at zero — a filter that hides its own empty options makes the vocabulary look
   * smaller than it is. `entity` is derived from senders and has no fixed list, so it is whatever
   * this mailbox actually turns out to contain.
   */
  async vocabulary(accountId: string, limit = 200): Promise<FacetVocabulary> {
    const [entities, domains, intents, vocabulary] = await Promise.all([
      this.facetCounts(accountId, 'entity', limit),
      this.facetCounts(accountId, 'domain', limit),
      this.facetCounts(accountId, 'intent', limit),
      this.vocabularies.approved(accountId),
    ]);

    const approved = (facet: 'domain' | 'intent', counts: Map<string, number>) =>
      vocabulary[facet].map((value) => ({
        value: value.name,
        messageCount: counts.get(value.name) ?? 0,
      }));

    return {
      entity: [...entities].map(([value, messageCount]) => ({ value, messageCount })),
      domain: approved('domain', domains),
      intent: approved('intent', intents),
    };
  }

  /** How many messages carry each value of one facet, commonest first. */
  private async facetCounts(
    accountId: string,
    facet: PivotFacet,
    limit: number,
  ): Promise<Map<string, number>> {
    const rows = await prisma.message_facets.groupBy({
      by: [facet],
      where: { connected_google_account_id: accountId, NOT: { [facet]: null } },
      _count: { _all: true },
      orderBy: { _count: { [facet]: 'desc' } },
      take: limit,
    });
    return new Map(
      rows
        .map((row) => [(row as Record<string, unknown>)[facet], row._count._all] as const)
        .filter((entry): entry is readonly [string, number] => typeof entry[0] === 'string'),
    );
  }
}

export const messageSearchService = new MessageSearchService();
