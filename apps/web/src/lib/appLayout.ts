import { useSyncExternalStore } from 'react';

/**
 * Which shape the signed-in app takes.
 *
 * `app` is AMO installed from Chrome and opened in its own window on a computer: there it is a
 * floating island over an empty window, and each screen opens in a tray from the island. `web` is
 * everything else — a browser tab gets the side panel, and a phone (installed or not) the tab bar
 * at the bottom, because the narrow layout is decided by width in the stylesheet.
 *
 * Read from `display-mode` rather than guessed from the user agent: Chrome reports `standalone`,
 * or `window-controls-overlay` when the title bar is folded into the app, only for an installed
 * window. The width condition keeps an installed phone on the phone layout. Both are one query,
 * so resizing the window across the breakpoint switches layouts live.
 */
const APP_QUERY = [
  '(display-mode: standalone) and (min-width: 768px)',
  '(display-mode: window-controls-overlay) and (min-width: 768px)',
].join(', ');

export type AppLayout = 'app' | 'web';

function read(): AppLayout {
  return window.matchMedia?.(APP_QUERY).matches ? 'app' : 'web';
}

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia?.(APP_QUERY);
  query?.addEventListener?.('change', onChange);
  return () => query?.removeEventListener?.('change', onChange);
}

export function useAppLayout(): AppLayout {
  return useSyncExternalStore(subscribe, read, () => 'web');
}
