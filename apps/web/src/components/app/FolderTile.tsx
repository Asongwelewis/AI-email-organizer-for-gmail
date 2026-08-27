import { Folder, FolderOpen } from 'lucide-react';

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
  onOpen: () => void;
}

export function FolderTile({
  name,
  path,
  count,
  childCount,
  unreadCount = 0,
  onOpen,
}: FolderTileProps) {
  const color = folderColor(path);
  const Icon = childCount > 0 ? FolderOpen : Folder;

  return (
    <button
      type="button"
      className="folder-tile"
      onClick={onOpen}
      style={{
        // One hue, and the theme decides the rest. Tint, icon, and label are built from it in
        // theme.css, so the label reads as part of the tile in both themes rather than printed
        // on top of it in one and lost in the other.
        ['--tile-hue' as string]: String(color.hue),
      }}
    >
      <span className="folder-tile__top">
        <Icon className="folder-tile__icon" aria-hidden="true" strokeWidth={1.5} />
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
  );
}
