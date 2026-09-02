import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeToggle } from '@web/components/ThemeToggle';
import { ThemeProvider } from './ThemeContext';
import { THEME_STORAGE_KEY, useTheme } from './useTheme';

/**
 * jsdom answers every media query with `matches: false`, which would silently mean "the OS wants
 * light" in every test. These helpers make the OS preference an explicit input.
 */
function mockSystemPrefersDark(dark: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('dark') ? dark : false,
      media: query,
      addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.add(listener),
      removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.delete(listener),
      dispatchEvent: () => false,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
    })),
  );
  return listeners;
}

function Probe() {
  const { preference, resolvedTheme } = useTheme();
  return <output data-testid="probe">{`${preference}/${resolvedTheme}`}</output>;
}

function renderTheme() {
  return render(
    <ThemeProvider>
      <Probe />
      <ThemeToggle />
    </ThemeProvider>,
  );
}

const probe = () => screen.getByTestId('probe').textContent;
const stamped = () => document.documentElement.getAttribute('data-theme');

describe('ThemeProvider', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    mockSystemPrefersDark(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to dark, even on a machine whose OS asks for light', () => {
    renderTheme();
    expect(probe()).toBe('dark/dark');
    expect(stamped()).toBe('dark');
  });

  it('lets an explicit light choice beat an OS that asks for dark', async () => {
    mockSystemPrefersDark(true);
    renderTheme();
    await userEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(probe()).toBe('light/light');
    // The stamp is what `theme.css` reads; without it the dark media query would still match.
    expect(stamped()).toBe('light');
  });

  it('removes the stamp under `system`, so the OS decides again', async () => {
    mockSystemPrefersDark(true);
    renderTheme();
    await userEvent.click(screen.getByRole('button', { name: 'Auto' }));
    expect(probe()).toBe('system/dark');
    expect(stamped()).toBeNull();
  });

  it('resolves `system` to light when the OS asks for light', async () => {
    mockSystemPrefersDark(false);
    renderTheme();
    await userEvent.click(screen.getByRole('button', { name: 'Auto' }));
    expect(probe()).toBe('system/light');
  });

  it('follows an OS theme change while Auto is selected', async () => {
    const listeners = mockSystemPrefersDark(true);
    renderTheme();
    await userEvent.click(screen.getByRole('button', { name: 'Auto' }));

    expect(probe()).toBe('system/dark');
    listeners.forEach((listener) => listener({ matches: false } as MediaQueryListEvent));

    await waitFor(() => expect(probe()).toBe('system/light'));
  });

  it('remembers the choice, so a reload does not undo it', async () => {
    const first = renderTheme();
    await userEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    // Unmounting and mounting again is the closest a jsdom test gets to a reload: the provider
    // has to read the preference back from storage rather than from its own retained state.
    first.unmount();
    renderTheme();
    expect(probe()).toBe('light/light');
  });

  it('ignores a stored value that is not a theme', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'chartreuse');
    renderTheme();
    expect(probe()).toBe('dark/dark');
  });

  it('still renders when storage throws outright', async () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage is blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage is blocked');
    });

    renderTheme();
    expect(probe()).toBe('dark/dark');

    // A preference that cannot be remembered still has to work for this session.
    await userEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect(probe()).toBe('light/light');

    getItem.mockRestore();
    setItem.mockRestore();
  });

  it('announces which option is on', () => {
    renderTheme();
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'false');
  });
});
