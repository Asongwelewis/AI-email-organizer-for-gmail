import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

/** What the island's window is showing: its menu, or a screen the side panel used to hold. */
export type IslandView = 'home' | 'notifications' | 'account';

export const ISLAND_WINDOW_ID = 'island-window';

/**
 * The window's state. It belongs to the screen it was opened over: a link inside it that leads
 * somewhere else — "Show folder", "Send feedback" — has done its job, so moving closes it.
 */
export function useIslandWindow() {
  const location = useLocation();
  const place = `${location.pathname}${location.search}`;
  const [opened, setOpened] = useState<{ view: IslandView; place: string } | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  // Derived, so the window is gone in the same render as the move. The effect then forgets it,
  // or coming back to the same place with the back button would open it again.
  const view = opened && opened.place === place ? opened.view : null;
  useEffect(() => {
    setOpened(null);
  }, [place]);

  const show = useCallback((next: IslandView) => setOpened({ view: next, place }), [place]);

  const open = useCallback(
    (next: IslandView) => {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement ? active : null;
      show(next);
    },
    [show],
  );

  /** Focus goes back to whatever opened the window, unless the person already clicked elsewhere. */
  const close = useCallback((restoreFocus = true) => {
    setOpened(null);
    if (restoreFocus) opener.current?.focus();
  }, []);

  return { view, open, show, close };
}
