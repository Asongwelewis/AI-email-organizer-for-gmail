/**
 * The AMO Island desktop program (`desktop/` in the repository): a small see-through window that
 * sits on the Windows desktop itself, always on top, showing AMO's own pages from this site.
 *
 * The program is Tauri, which injects its bridge into the page before any script of ours runs —
 * so its presence is known at module load, and every page the island navigates to knows it too.
 * Nothing here does anything in a browser: every call is a no-op without the bridge.
 */

interface LogicalPoint {
  x: number;
  y: number;
}

interface TauriWindow {
  startDragging(): Promise<void>;
  setSize(size: unknown): Promise<void>;
  setPosition(position: unknown): Promise<void>;
  outerPosition(): Promise<{ toLogical(scaleFactor: number): LogicalPoint }>;
  scaleFactor(): Promise<number>;
  onMoved(handler: (event: { payload: { x: number; y: number } }) => void): Promise<() => void>;
}

interface TauriGlobal {
  core: { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> };
  window: { getCurrentWindow(): TauriWindow };
  dpi: {
    LogicalSize: new (width: number, height: number) => unknown;
    LogicalPosition: new (x: number, y: number) => unknown;
  };
}

export const IN_ISLAND_APP = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function tauri(): TauriGlobal | null {
  return (window as Window & { __TAURI__?: TauriGlobal }).__TAURI__ ?? null;
}

function currentWindow(): TauriWindow | null {
  return tauri()?.window.getCurrentWindow() ?? null;
}

/** The screen area the island may use, in the same CSS pixels the window is placed in. */
export function workArea() {
  const screen = window.screen as Screen & { availLeft?: number; availTop?: number };
  return {
    left: screen.availLeft ?? 0,
    top: screen.availTop ?? 0,
    width: screen.availWidth,
    height: screen.availHeight,
  };
}

export const islandApp = {
  /** Hands the pointer to Windows, which moves the whole window until the button is released. */
  startDragging(): void {
    void currentWindow()
      ?.startDragging()
      .catch(() => undefined);
  },

  /** Moves and resizes the window together, in CSS pixels. */
  async place(x: number, y: number, width: number, height: number): Promise<void> {
    const bridge = tauri();
    const win = currentWindow();
    if (!bridge || !win) return;
    const left = Math.round(x);
    const top = Math.round(y);
    await win.setSize(new bridge.dpi.LogicalSize(Math.round(width), Math.round(height)));
    await win.setPosition(new bridge.dpi.LogicalPosition(left, top));
  },

  /** Where the window is now, in CSS pixels. */
  async position(): Promise<LogicalPoint | null> {
    const win = currentWindow();
    if (!win) return null;
    const [physical, scale] = await Promise.all([win.outerPosition(), win.scaleFactor()]);
    return physical.toLogical(scale);
  },

  /** Called whenever the window moves — after a drag, or after `place`. */
  async onMoved(handler: () => void): Promise<() => void> {
    const win = currentWindow();
    if (!win) return () => undefined;
    return win.onMoved(() => handler());
  },

  /** Opens a link in the person's own browser rather than inside the island. */
  openExternal(url: string): void {
    const bridge = tauri();
    if (!bridge) {
      window.open(url, '_blank', 'noopener');
      return;
    }
    void bridge.core.invoke('plugin:opener|open_url', { url }).catch(() => undefined);
  },
};
