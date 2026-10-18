import { useEffect, useState } from 'react';
import { Folder, FolderOpen, Star } from 'lucide-react';

import { formatCount } from '@web/lib/format';
import { folderColor } from '@web/lib/folderColor';

export interface FolderTileProps {
  name: string;
  /** Hashed for colour, so a folder keeps its colour wherever it appears in the grid. */
  path: string;
  count: number | null;
  childCount: number;
  /**
   * Unread mail under this folder, counted through the whole subtree.
   *
   * The point of the tile is answering "where is the new mail" without opening anything, so a
   * parent has to carry what is unread beneath it — unread mail three levels down is still mail
   * you have not seen, and a folder that stayed silent about it would send you hunting.
   */
  unreadCount?: number;
  /**
   * A brand folder's logo, served by our own API. When it is missing or fails to load the tile
   * keeps its folder icon — a broken image is worse than no image.
   */
  iconUrl?: string | null;
  /** Whether this folder is starred. The star only appears when `onToggleFavorite` is given. */
  favorite?: boolean;
  onToggleFavorite?: () => void;
  onOpen: () => void;
}

export function FolderTile({
  name,
  path,
  count,
  childCount,
  unreadCount = 0,
  iconUrl = null,
  favorite = false,
  onToggleFavorite,
  onOpen,
}: FolderTileProps) {
  const color = folderColor(path);
  const Icon = childCount > 0 ? FolderOpen : Folder;
  const [logoFailed, setLogoFailed] = useState(false);
  useEffect(() => setLogoFailed(false), [iconUrl]);
  const showLogo = Boolean(iconUrl) && !logoFailed;

  return (
    // A wrapper because the star is a second button, and a button cannot sit inside another.
    <div
      className="folder-tile-wrap"
      style={{
        // One hue, and the theme decides the rest. Tint, icon, and label are built from it in
        // theme.css, so the label reads as part of the tile in both themes rather than printed
        // on top of it in one and lost in the other.
        ['--tile-hue' as string]: String(color.hue),
      }}
    >
      <button
        type="button"
        className={`folder-tile${onToggleFavorite ? ' folder-tile--starrable' : ''}`}
        onClick={onOpen}
      >
        <span className="folder-tile__top">
          {showLogo ? (
            // Decorative: the folder's name, right below, already says whose mail this is.
            <span className="folder-tile__logo" aria-hidden="true">
              <img
                src={iconUrl!}
                alt=""
                width={32}
                height={32}
                loading="lazy"
                decoding="async"
                onError={() => setLogoFailed(true)}
              />
            </span>
          ) : (
            <Icon className="folder-tile__icon" aria-hidden="true" strokeWidth={1.5} />
          )}
          {unreadCount > 0 ? (
            <span className="folder-tile__unread">{formatCount(unreadCount)} new</span>
          ) : childCount > 0 ? (
            <span className="folder-tile__children">
              {childCount} {childCount === 1 ? 'folder' : 'folders'}
            </span>
          ) : null}
        </span>
        <span className="folder-tile__count" aria-hidden={count === null}>
          {formatCount(count)}
        </span>
        <span className="folder-tile__name">{name}</span>
        <span className="sr-only">
          {count === null ? 'Message count unavailable' : `${count} messages`}
          {unreadCount > 0 ? `, ${unreadCount} unread` : ''}
        </span>
      </button>
      {onToggleFavorite ? (
        <button
          type="button"
          className={`folder-tile__star${favorite ? ' folder-tile__star--on' : ''}`}
          aria-pressed={favorite}
          aria-label={favorite ? `Remove ${name} from favourites` : `Add ${name} to favourites`}
          title={favorite ? 'Remove from favourites' : 'Add to favourites'}
          onClick={onToggleFavorite}
        >
          <Star aria-hidden="true" strokeWidth={1.75} fill={favorite ? 'currentColor' : 'none'} />
        </button>
      ) : null}
    </div>
  );
}
