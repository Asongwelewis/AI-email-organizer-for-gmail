import { useCallback, useEffect, useRef, useState } from 'react';

import { islandApp, workArea } from '@web/lib/islandApp';

/** Which side of the island its tray opens on — towards the middle of the screen. */
export type Placement = 'below' | 'above';

const ANCHOR_KEY = 'amo:island-anchor';

/**
 * The window around the island, in CSS pixels. Closed, it is the island plus room for an icon at
 * full swell and its name; open, it is the tray's width and as tall as the screen allows. Kept
 * small on purpose: even its see-through parts take clicks away from the desktop beneath.
 */
export const FRAME = {
  closedWidth: 460,
  closedHeight: 132,
  /** Between the island and its window's edge. */
  inset: 10,
  trayWidth: 640,
  trayMaxHeight: 640,
  gap: 10,
  edge: 12,
} as const;

/** Where the island is on the screen: its centre, and its top edge. */
interface Anchor {
  centreX: number;
  top: number;
}

function readAnchor(): Anchor | null {
  try {
    const saved = JSON.parse(window.localStorage.getItem(ANCHOR_KEY) ?? 'null') as {
      centreX?: unknown;
      top?: unknown;
    } | null;
    if (saved && typeof saved.centreX === 'number' && typeof saved.top === 'number') {
      return { centreX: saved.centreX, top: saved.top };
    }
  } catch {
    // Unreadable: back to the top centre.
  }
  return null;
}

function saveAnchor(anchor: Anchor) {
  try {
    window.localStorage.setItem(
      ANCHOR_KEY,
      JSON.stringify({ centreX: Math.round(anchor.centreX), top: Math.round(anchor.top) }),
    );
  } catch {
    // Remembering the place is a convenience.
  }
}

/** The top centre of the screen, like the island on a MacBook. */
function defaultAnchor(): Anchor {
  const area = workArea();
  return { centreX: area.left + area.width / 2, top: area.top + FRAME.inset };
}

/** A remembered place on a screen that has since changed is pulled back onto this one. */
function onScreen(anchor: Anchor): Anchor {
  const area = workArea();
  const half = FRAME.closedWidth / 2;
  return {
    centreX: Math.min(Math.max(anchor.centreX, area.left + half), area.left + area.width - half),
    top: Math.min(Math.max(anchor.top, area.top), area.top + area.height - 64),
  };
}

function placementFor(anchor: Anchor, islandHeight: number): Placement {
  const area = workArea();
  return anchor.top + islandHeight / 2 > area.top + area.height / 2 ? 'above' : 'below';
}

/**
 * Keeps the desktop program's window fitted around the island, so the island stays exactly where
 * it was put on the screen.
 *
 * Closed, the window is small; when a tray opens it grows towards the middle of the screen — down
 * from an island near the top, up from one near the bottom — and shrinks back once the tray has
 * gone. Windows moves the whole window when the island is dragged; afterwards this works out where
 * the island ended up and remembers it, so it comes back there after a restart.
 *
 * `shift` is how far the island sits off its window's centre: near a screen edge the open window
 * is pushed back on screen, and the island is moved within it by the same amount to stay put.
 */
export function useIslandFrame(
  enabled: boolean,
  trayOpen: boolean,
  islandHeight: () => number,
  onShift: (shift: number) => void,
) {
  const anchor = useRef<Anchor>(onScreen(readAnchor() ?? defaultAnchor()));
  const [placement, setPlacement] = useState<Placement>(() => placementFor(anchor.current, 54));
  const placementRef = useRef(placement);
  placementRef.current = placement;
  const size = useRef<{ width: number; height: number }>({
    width: FRAME.closedWidth,
    height: FRAME.closedHeight,
  });
  const shift = useRef(0);

  const fit = useCallback(
    async (open: boolean, side: Placement) => {
      const area = workArea();
      const island = islandHeight();
      const trayHeight = Math.max(
        200,
        Math.min(
          FRAME.trayMaxHeight,
          area.height - island - FRAME.inset - FRAME.gap - 3 * FRAME.edge,
        ),
      );
      const width = open ? FRAME.trayWidth + 2 * FRAME.edge : FRAME.closedWidth;
      const height = open
        ? FRAME.inset + island + FRAME.gap + trayHeight + FRAME.edge
        : FRAME.closedHeight;
      const { centreX, top } = anchor.current;
      const x = Math.min(Math.max(centreX - width / 2, area.left), area.left + area.width - width);
      const y = side === 'below' ? top - FRAME.inset : top + island + FRAME.inset - height;
      shift.current = centreX - (x + width / 2);
      onShift(shift.current);
      size.current = { width, height };
      await islandApp.place(x, y, width, height);
    },
    [islandHeight, onShift],
  );

  // Fit on start (back to where it was left), whenever the tray opens or closes, and when the
  // island changes sides. Closing waits for the tray's own exit so it is not cut off mid-fade.
  useEffect(() => {
    if (!enabled) return;
    if (trayOpen) {
      void fit(true, placement);
      return;
    }
    const timer = window.setTimeout(() => void fit(false, placement), 200);
    return () => window.clearTimeout(timer);
  }, [enabled, fit, placement, trayOpen]);

  // After a drag: where is the island now? Fitting moves the window too, and lands back on the
  // same anchor, so this never chases itself.
  useEffect(() => {
    if (!enabled) return;
    let timer: number | undefined;
    let stop: () => void = () => undefined;
    let cancelled = false;
    void islandApp
      .onMoved(() => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          void islandApp.position().then((position) => {
            if (!position || cancelled) return;
            const island = islandHeight();
            const { width, height } = size.current;
            const side = placementRef.current;
            anchor.current = {
              centreX: position.x + width / 2 + shift.current,
              top: position.y + (side === 'below' ? FRAME.inset : height - FRAME.inset - island),
            };
            saveAnchor(anchor.current);
            const next = placementFor(anchor.current, island);
            if (next !== side) setPlacement(next);
          });
        }, 250);
      })
      .then((unlisten) => {
        if (cancelled) unlisten();
        else stop = unlisten;
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      stop();
    };
  }, [enabled, islandHeight]);

  return placement;
}

/** Where the connect card sits before there is an island: the island's own place. */
export function placeConnectCard(width: number, height: number): void {
  const { centreX, top } = onScreen(readAnchor() ?? defaultAnchor());
  void islandApp.place(centreX - width / 2, top - FRAME.inset, width, height);
}
