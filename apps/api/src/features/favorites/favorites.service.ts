import type { favorite_folders } from '@prisma/client';

import { prisma } from '@api/database/prisma.js';
import { AppError } from '@api/errors/AppError.js';
import {
  activityRepository,
  type ActivityRepository,
} from '@api/features/activity/activity.repository.js';
import { emailIdentity } from '@api/features/label-discovery/label-normalization.js';
import { parseFacetKey, type PivotFacet } from '@api/features/label-discovery/pivot.js';
import { LABEL_ROOT } from '@api/features/label-discovery/taxonomy-planner.js';
import { facetFilterFromKey } from '@api/features/labels/pivot.service.js';

/**
 * Folders someone starred, so the ones they open every day are one tap away.
 *
 * A favourite is a facet combination, exactly like the folder it was starred on, and its counts
 * are read straight from `message_facets` — so it keeps working however the mailbox is arranged
 * and whatever time window the Inbox is showing. Counts are over all mail: a favourite is a place
 * you go to, not a view of today.
 */

/** Enough for anyone's real favourites; a ceiling so a runaway client cannot grow it forever. */
export const MAX_FAVORITES = 100;

export interface FavoriteFolder {
  id: string;
  facetKey: string;
  /** The arrangement it was starred in, so opening it lands in the view it came from. */
  order: PivotFacet[];
  name: string;
  path: string;
  fullPath: string;
  messageCount: number;
  unreadCount: number;
  latestReceivedAt: string | null;
  /** A brand favourite's logo domain, the same as its folder tile shows. */
  iconDomain: string | null;
  createdAt: string;
}

export class FavoritesService {
  constructor(private readonly accounts: ActivityRepository = activityRepository) {}

  async list(userId: string): Promise<FavoriteFolder[]> {
    const account = await this.accounts.activeAccountForUser(userId);
    const rows = await prisma.favorite_folders.findMany({
      where: { connected_google_account_id: account.id },
      orderBy: { created_at: 'desc' },
      take: MAX_FAVORITES,
    });
    const described = await Promise.all(rows.map((row) => this.describe(account.id, row)));
    return described.filter((favorite): favorite is FavoriteFolder => favorite !== null);
  }

  /** The facet keys this mailbox has starred, for drawing filled stars on folder tiles. */
  async keys(userId: string): Promise<string[]> {
    const account = await this.accounts.activeAccountForUser(userId);
    const rows = await prisma.favorite_folders.findMany({
      where: { connected_google_account_id: account.id },
      select: { facet_key: true },
      take: MAX_FAVORITES,
    });
    return rows.map((row) => row.facet_key);
  }

  /**
   * Stars a folder. Idempotent: starring it again keeps the one row and remembers the newer
   * arrangement. The key has to be one a folder could have — the arrangement's own facets, in its
   * order — so a client cannot store something that opens nowhere.
   */
  async add(userId: string, facetKey: string, order: PivotFacet[]): Promise<FavoriteFolder> {
    const parts = parseFacetKey(facetKey);
    const facets = parts?.map((part) => part.facet) ?? [];
    const prefixOfOrder = facets.every((facet, index) => order[index] === facet);
    if (!parts || !prefixOfOrder || new Set(order).size !== order.length) {
      throw new AppError('FAVORITE_VALIDATION_FAILED', 'That is not a folder.', 400);
    }
    const account = await this.accounts.activeAccountForUser(userId);
    const existing = await prisma.favorite_folders.count({
      where: { connected_google_account_id: account.id },
    });
    const already = await prisma.favorite_folders.findUnique({
      where: {
        connected_google_account_id_facet_key: {
          connected_google_account_id: account.id,
          facet_key: facetKey,
        },
      },
    });
    if (!already && existing >= MAX_FAVORITES) {
      throw new AppError(
        'FAVORITES_LIMIT_REACHED',
        `You can keep up to ${MAX_FAVORITES} favourite folders.`,
        409,
      );
    }
    const row = await prisma.favorite_folders.upsert({
      where: {
        connected_google_account_id_facet_key: {
          connected_google_account_id: account.id,
          facet_key: facetKey,
        },
      },
      create: { connected_google_account_id: account.id, facet_key: facetKey, pivot_order: order },
      update: { pivot_order: order },
    });
    const described = await this.describe(account.id, row);
    if (!described) throw new AppError('FAVORITE_VALIDATION_FAILED', 'That is not a folder.', 400);
    return described;
  }

  async remove(userId: string, facetKey: string): Promise<void> {
    const account = await this.accounts.activeAccountForUser(userId);
    await prisma.favorite_folders.deleteMany({
      where: { connected_google_account_id: account.id, facet_key: facetKey },
    });
  }

  private async describe(accountId: string, row: favorite_folders): Promise<FavoriteFolder | null> {
    const parts = parseFacetKey(row.facet_key);
    // A key stored before a vocabulary change can stop being a folder; it is skipped, not shown
    // as an empty tile that opens nowhere.
    if (!parts) return null;
    const where = {
      connected_google_account_id: accountId,
      ...facetFilterFromKey(row.facet_key),
      message: { deleted_at: null },
    };
    const [messageCount, unreadCount, latest] = await Promise.all([
      prisma.message_facets.count({ where }),
      prisma.message_facets.count({
        where: { ...where, message: { deleted_at: null, is_unread: true } },
      }),
      prisma.message_facets.findFirst({
        where,
        orderBy: { message: { internal_date: 'desc' } },
        select: { message: { select: { internal_date: true, sender_email: true } } },
      }),
    ]);
    const path = parts.map((part) => part.name).join('/');
    const hasEntity = parts.some((part) => part.facet === 'entity');
    return {
      id: row.id,
      facetKey: row.facet_key,
      order: row.pivot_order as PivotFacet[],
      name: parts.at(-1)!.name,
      path,
      fullPath: `${LABEL_ROOT}/${path}`,
      messageCount,
      unreadCount,
      latestReceivedAt: latest?.message.internal_date?.toISOString() ?? null,
      iconDomain: hasEntity
        ? emailIdentity(latest?.message.sender_email ?? null).registrableDomain || null
        : null,
      createdAt: row.created_at.toISOString(),
    };
  }
}

export const favoritesService = new FavoritesService();
