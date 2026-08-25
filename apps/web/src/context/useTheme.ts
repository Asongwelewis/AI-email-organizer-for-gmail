import { createContext, useContext } from 'react';

/**
 * Three preferences, two outcomes. `system` is a real choice and not the absence of one, which is
 * why it is stored rather than represented by an empty slot.
 */
export type ThemePreference = 'dark' | 'light' | 'system';

/** What `system` actually resolved to, and therefore what is painted. */
export type ResolvedTheme = 'dark' | 'light';

/**
 * Dark is the default, not `system`. Someone arriving for the first time gets the theme this
 * product is designed in; `system` is available for people who want their machine to decide.
 */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'dark';

/**
 * Shared with the pre-paint script in `index.html`. That script cannot import from here, so if
 * this key changes the inline script has to change with it or the first frame paints the wrong
 * theme and then corrects itself.
 */
export const THEME_STORAGE_KEY = 'mailmind_theme';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'dark' || value === 'light' || value === 'system';
}

export interface ThemeContextValue {
  /** What the user chose. */
  preference: ThemePreference;
  /** What that choice resolves to right now — never `system`. */
  resolvedTheme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used within ThemeProvider');
  return value;
}
