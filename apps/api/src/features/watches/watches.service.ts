import { prisma } from '@api/database/prisma.js';
import { AppError } from '@api/errors/AppError.js';
import {
  activityRepository,
  type ActivityRepository,
} from '@api/features/activity/activity.repository.js';
import { describeWatch, type Watch } from './watch-match.js';

/**
 * Watched folders: the eye on a folder tile.
 *
 * Someone watches a folder because they keep checking Gmail in case it has something — an
 * application portal, a bank, a landlord. A watched folder sorts first in the Inbox, so it is never
 * behind "Show all", and new mail in it alerts their devices (see `notifications.service`). Storing
 * it is all this does; what it means is decided where the folders are drawn and where mail is
 * announced.
 */

/** A watch is an alert. Past a couple of dozen, every folder is urgent and none of them is. */
export const MAX_WATCHES = 25;

export class WatchesService {
  constructor(private readonly accounts: ActivityRepository = activityRepository) {}

  /** The canonical keys this mailbox watches, for drawing the eyes and sorting the folders. */
  async keys(userId: string): Promise<string[]> {
    const account = await this.accounts.activeAccountForUser(userId);
    const rows = await prisma.watched_folders.findMany({
      where: { connected_google_account_id: account.id },
      orderBy: { created_at: 'asc' },
      select: { facet_key: true },
      take: MAX_WATCHES,
    });
    return rows.map((row) => row.facet_key);
  }

  /**
   * The watches of one connected account, for the notifier. A key that stopped being a folder —
   * a vocabulary changed under it — covers nothing and is left out rather than failing the check.
   */
  async forAccount(accountId: string): Promise<Watch[]> {
    const rows = await prisma.watched_folders.findMany({
      where: { connected_google_account_id: accountId },
      orderBy: { created_at: 'asc' },
      select: { facet_key: true },
      take: MAX_WATCHES,
    });
    return rows.flatMap((row) => {
      const watch = describeWatch(row.facet_key);
      return watch ? [watch] : [];
    });
  }

  /** Watches a folder. Idempotent, and keyed canonically whatever order the key arrives in. */
  async add(userId: string, facetKey: string): Promise<string> {
    const watch = describeWatch(facetKey);
    if (!watch) throw new AppError('WATCH_VALIDATION_FAILED', 'That is not a folder.', 400);
    const account = await this.accounts.activeAccountForUser(userId);
    const key = {
      connected_google_account_id_facet_key: {
        connected_google_account_id: account.id,
        facet_key: watch.facetKey,
      },
    };
    const [count, already] = await Promise.all([
      prisma.watched_folders.count({ where: { connected_google_account_id: account.id } }),
      prisma.watched_folders.findUnique({ where: key, select: { id: true } }),
    ]);
    if (!already && count >= MAX_WATCHES) {
      throw new AppError(
        'WATCHES_LIMIT_REACHED',
        `You can watch up to ${MAX_WATCHES} folders. Stop watching one to watch this one.`,
        409,
      );
    }
    await prisma.watched_folders.upsert({
      where: key,
      create: { connected_google_account_id: account.id, facet_key: watch.facetKey },
      update: {},
    });
    return watch.facetKey;
  }

  /** Stops watching a folder, named in any order. Removing one that is not watched is fine. */
  async remove(userId: string, facetKey: string): Promise<void> {
    const watch = describeWatch(facetKey);
    if (!watch) return;
    const account = await this.accounts.activeAccountForUser(userId);
    await prisma.watched_folders.deleteMany({
      where: { connected_google_account_id: account.id, facet_key: watch.facetKey },
    });
  }
}

export const watchesService = new WatchesService();
