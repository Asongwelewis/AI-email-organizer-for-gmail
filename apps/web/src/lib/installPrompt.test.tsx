import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ThemeToggle } from '@web/components/ThemeToggle';
import { ThemeProvider } from '@web/context/ThemeContext';
import { captureInstallPrompt } from './installPrompt';

/**
 * Chrome offers installation once, early, through `beforeinstallprompt`. The button exists only
 * while that offer is held, and pressing it is what shows the browser's own install dialog.
 */
describe('installing AMO as an app', () => {
  it('shows an install button only once the browser offers, and opens the browser`s dialog', async () => {
    captureInstallPrompt();
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    expect(screen.queryByRole('button', { name: /install app/i })).not.toBeInTheDocument();

    const prompt = vi.fn(async () => undefined);
    const offer = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt,
      userChoice: Promise.resolve({ outcome: 'accepted' as const }),
    });
    act(() => {
      window.dispatchEvent(offer);
    });
    // The browser's own mini-infobar is suppressed; the button is the invitation instead.
    expect(offer.defaultPrevented).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: /install app/i }));
    expect(prompt).toHaveBeenCalledOnce();
    // An offer is good for one prompt; the button goes until the browser makes another.
    expect(await screen.findByRole('group', { name: 'Colour theme' })).not.toHaveTextContent(
      /install/i,
    );
  });
});
