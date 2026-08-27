import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  DEFAULT_THEME_PREFERENCE,
  THEME_COLOR,
  THEME_STORAGE_KEY,
  ThemeContext,
  isThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from './useTheme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Every storage access is wrapped. A private window, cleared site data, or a browser configured to
 * block storage makes these throw on access rather than return null, and a theme preference is
 * never worth failing a render over.
 */
function readStoredPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : DEFAULT_THEME_PREFERENCE;
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

function writeStoredPreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // A preference that cannot be remembered still has to work for this session.
  }
}

function systemPrefersDark(): boolean {
  return window.matchMedia?.(DARK_QUERY).matches ?? false;
}

function resolve(preference: ThemePreference): ResolvedTheme {
  if (preference !== 'system') return preference;
  return systemPrefersDark() ? 'dark' : 'light';
}

/**
 * `system` REMOVES the attribute rather than stamping a value.
 *
 * That is the whole contract with `theme.css`: the dark media query is guarded on
 * `:root:not([data-theme='light'])`, so an absent attribute lets the OS decide and a present one
 * overrides it in both directions. Stamping `data-theme="dark"` for a system preference would
 * work today and then stop following the OS the moment it changed.
 */
function applyPreference(preference: ThemePreference, resolved: ResolvedTheme): void {
  const root = document.documentElement;
  if (preference === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', preference);

  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])')
    ?.setAttribute('content', THEME_COLOR[resolved]);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);
  const [systemIsDark, setSystemIsDark] = useState<boolean>(systemPrefersDark);

  const resolvedTheme: ResolvedTheme =
    preference === 'system' ? (systemIsDark ? 'dark' : 'light') : preference;

  // Only meaningful while the preference is `system`, but the listener is kept attached either
  // way: switching back to `system` must not need a reload to start following the OS again.
  useEffect(() => {
    const query = window.matchMedia?.(DARK_QUERY);
    if (!query) return;
    const onChange = (event: MediaQueryListEvent) => setSystemIsDark(event.matches);
    query.addEventListener('change', onChange);
    setSystemIsDark(query.matches);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    applyPreference(preference, resolvedTheme);
  }, [preference, resolvedTheme]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    writeStoredPreference(next);
    // Applied here as well as in the effect so the paint happens in the same frame as the click.
    applyPreference(next, resolve(next));
  }, []);

  const value = useMemo(
    () => ({ preference, resolvedTheme, setPreference }),
    [preference, resolvedTheme, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
