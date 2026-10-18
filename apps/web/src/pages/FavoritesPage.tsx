import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { ErrorNotice } from '@web/components/app/ErrorNotice';
import { FolderTile } from '@web/components/app/FolderTile';
import { EmptyState, LoadingState } from '@web/components/app/StateViews';
import { brandIconUrl } from '@web/lib/brandIcon';
import { useFavorites } from '@web/queries/favorites';
import { queryKeys } from '@web/queries/queryKeys';
import { api } from '@web/services/http';
import { pivotOrderKey } from '@web/types/facets';
import type { FavoriteFolder } from '@web/types/favorites';

/** How often an open screen picks up new mail in the starred folders. */
const LIVE_REFRESH_MS = 60_000;

/**
 * The folders someone starred, in the order they starred them.
 *
 * A favourite opens in the arrangement it was starred from and over all mail, so it always lands on
 * the folder it names — a favourite you cannot open because today's window happens to be empty
 * would be a favourite that does not work.
 */
function inboxLink(favorite: FavoriteFolder): string {
  const params = new URLSearchParams({
    order: pivotOrderKey(favorite.order),
    folder: favorite.facetKey,
    range: 'all',
  });
  return `/inbox?${params.toString()}`;
}

export function FavoritesPage() {
  const navigate = useNavigate();
  const { isFavorite, toggleFavorite } = useFavorites();
  const favoritesQuery = useQuery({
    queryKey: queryKeys.favorites,
    queryFn: () => api.getFavorites(),
    refetchInterval: LIVE_REFRESH_MS,
  });

  const favorites = favoritesQuery.data ?? [];

  return (
    <section className="screen">
      <header className="screen__head">
        <h1 className="screen__title">Favourites</h1>
      </header>
      <p className="screen__hint">
        The folders you starred, with everything in them. Tap the star on any folder in your Inbox
        to add it here.
      </p>

      {favoritesQuery.isPending ? <LoadingState label="Loading favourites" /> : null}
      {favoritesQuery.isError ? (
        <ErrorNotice
          error={favoritesQuery.error}
          title="Favourites could not be loaded"
          onRetry={() => void favoritesQuery.refetch()}
        />
      ) : null}

      {favoritesQuery.isSuccess && favorites.length === 0 ? (
        <EmptyState
          title="No favourites yet"
          description="Star a folder in your Inbox and it will wait for you here."
        />
      ) : null}

      {favorites.length > 0 ? (
        <div className="tile-grid">
          {favorites.map((favorite) => (
            <FolderTile
              key={favorite.facetKey}
              name={favorite.name}
              path={favorite.fullPath}
              count={favorite.messageCount}
              childCount={0}
              unreadCount={favorite.unreadCount}
              iconUrl={brandIconUrl(favorite.iconDomain)}
              favorite={isFavorite(favorite.facetKey)}
              onToggleFavorite={() => toggleFavorite(favorite.facetKey, favorite.order)}
              onOpen={() => navigate(inboxLink(favorite))}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
