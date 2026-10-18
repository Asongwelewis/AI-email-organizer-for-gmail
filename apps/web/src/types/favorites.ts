import type { PivotFacet } from './facets';

/** A starred folder, with its counts over all mail. */
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
  iconDomain: string | null;
  createdAt: string;
}
