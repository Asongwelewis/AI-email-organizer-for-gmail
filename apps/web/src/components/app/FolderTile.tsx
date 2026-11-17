import { useEffect, useState } from 'react';
import { Eye, Folder, FolderOpen, Star } from 'lucide-react';

import { formatCount } from '@web/lib/format';
import { folderColor } from '@web/lib/folderColor';
import type { WatchState } from '@web/lib/watches';

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
  /**
   * How the watches touch this folder. `covered` means a broader folder is watched, so the eye is
   * on but belongs to that folder; `leads` means a folder inside is watched. The eye only appears
   * when `onToggleWatch` is given.
   */
  watch?: WatchState | null;
  onToggleWatch?: () => void;
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
  watch = null,
  onToggleWatch,
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
      className={`folder-tile-wrap${watch === 'watched' || watch === 'covered' ? ' folder-tile-wrap--watched' : ''}`}
      style={{
        // One hue, and the theme decides the rest. Tint, icon, and label are built from it in
        // theme.css, so the label reads as part of the tile in both themes rather than printed
        // on top of it in one and lost in the other.
        ['--tile-hue' as string]: String(color.hue),
      }}
    >
      <button
        type="button"
        className={`folder-tile${onToggleFavorite || onToggleWatch ? ' folder-tile--starrable' : ''}`}
        onClick={onOpen}
      >
        {/* The corner says what is waiting inside, before anything is opened. */}
        {unreadCount > 0 ? (
          <span className="folder-tile__corner folder-tile__unread">
            {formatCount(unreadCount)} new
          </span>
        ) : childCount > 0 ? (
          <span className="folder-tile__corner folder-tile__children">
            {childCount} {childCount === 1 ? 'folder' : 'folders'}
          </span>
        ) : null}
        <span className="folder-tile__glyph">
          {showLogo ? (
            // Decorative: the folder's name, right below, already says whose mail this is.
            <span className="folder-tile__logo" aria-hidden="true">
              <img
                src={iconUrl!}
                alt=""
                width={48}
                height={48}
                loading="lazy"
                decoding="async"
                onError={() => setLogoFailed(true)}
              />
            </span>
          ) : (
            <Icon className="folder-tile__icon" aria-hidden="true" strokeWidth={1.25} />
          )}
        </span>
        <span className="folder-tile__name">{name}</span>
        <span className="folder-tile__count" aria-hidden={count === null}>
          {formatCount(count)}
        </span>
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
      {onToggleWatch ? <WatchEye name={name} state={watch} onToggle={onToggleWatch} /> : null}
    </div>
  );
}

/**
 * The eye in the bottom-right corner: watch this folder. A watched folder comes first in the
 * Inbox, and new mail in it alerts this person's devices and stays on screen until dismissed.
 */
function WatchEye({
  name,
  state,
  onToggle,
}: {
  name: string;
  state: WatchState | null;
  onToggle: () => void;
}) {
  // Covered by a broader watch: the eye is on, but switching it off happens on that folder.
  if (state === 'covered') {
    return (
      <span
        className="folder-tile__eye folder-tile__eye--on folder-tile__eye--inherited"
        role="img"
        aria-label={`${name} is watched as part of a folder above it`}
        title="Watched as part of the folder above"
      >
        <Eye aria-hidden="true" strokeWidth={2} />
      </span>
    );
  }
  const watched = state === 'watched';
  return (
    <button
      type="button"
      className={`folder-tile__eye${watched ? ' folder-tile__eye--on' : ''}${
        state === 'leads' ? ' folder-tile__eye--inside' : ''
      }`}
      aria-pressed={watched}
      aria-label={watched ? `Stop watching ${name}` : `Watch ${name}`}
      title={
        watched
          ? 'Stop watching'
          : state === 'leads'
            ? 'A folder inside is watched. Watch all of this one'
            : 'Watch: keep it at the top and alert me to new mail'
      }
      onClick={onToggle}
    >
      <Eye aria-hidden="true" strokeWidth={watched ? 2.25 : 1.75} />
    </button>
  );
}
