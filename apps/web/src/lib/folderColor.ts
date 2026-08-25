/**
 * A folder's colour is derived from its path, never from its position in a list. Sorting,
 * filtering, or adding a folder must not repaint the grid: a folder the eye has learned to find by
 * colour has to keep that colour between renders and between sessions.
 *
 * Only the HUE is decided here. Lightness and saturation belong to the theme — a tint that reads
 * as a soft pastel on white is a glare on graphite, and baking both themes into this function
 * would mean the hash had to know which one is showing. It does not: `FolderTile` sets one
 * `--tile-hue`, and `theme.css` builds the surface, ink, and hairline from it per theme. So a
 * folder keeps its identity across renders, across sessions, AND across a theme switch.
 */
export interface FolderColor {
  /** Degrees on the colour wheel. Stable for a given path, forever. */
  hue: number;
}

/** FNV-1a. Small, stable, and dependency-free; the exact function matters less than that it never changes. */
function hash(value: string): number {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return result >>> 0;
}

/**
 * Hues are picked off a fixed wheel rather than the raw hash so no folder lands on a muddy
 * yellow-green, and so two adjacent folders are unlikely to look identical.
 */
const HUES = [8, 24, 42, 96, 152, 176, 198, 218, 244, 268, 292, 322] as const;

export function folderColor(path: string): FolderColor {
  return { hue: HUES[hash(path.toLowerCase()) % HUES.length] ?? HUES[0] };
}
