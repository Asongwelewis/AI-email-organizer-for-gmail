/**
 * A folder's colour is derived from its path, never from its position in a list. Sorting,
 * filtering, or adding a folder must not repaint the grid: a folder the eye has learned to find by
 * colour has to keep that colour between renders and between sessions.
 */
export interface FolderColor {
  /** Soft tint behind the tile. */
  surface: string;
  /** Same hue, dark enough for icon and label text to read on the tint. */
  ink: string;
  /** Hairline in the same hue, for the tile border. */
  line: string;
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
  const hue = HUES[hash(path.toLowerCase()) % HUES.length] ?? HUES[0];
  return {
    surface: `hsl(${hue} 46% 94%)`,
    ink: `hsl(${hue} 58% 26%)`,
    line: `hsl(${hue} 34% 84%)`,
  };
}
