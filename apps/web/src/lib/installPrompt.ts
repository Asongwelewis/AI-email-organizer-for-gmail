import { useSyncExternalStore } from 'react';

/**
 * Installing AMO as an app — its own window and its own icon among the others — from a button.
 *
 * Chrome and Edge offer this through `beforeinstallprompt`, fired once, early, when the site meets
 * their installability rules (a manifest and a service worker, which the PWA build provides). It
 * has to be caught when it fires and kept, because there is no asking for it later; that is why
 * `captureInstallPrompt` runs from `main.tsx` before anything renders. Calling `prompt()` on the
 * kept event is what shows the browser's own "Install AMO?" dialog.
 *
 * Browsers that never fire it — Safari, Firefox — and a copy that is already installed get no
 * button at all, rather than one that does nothing.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
let captured = false;

function notify(): void {
  for (const listener of listeners) listener();
}

export function captureInstallPrompt(): void {
  if (captured || typeof window === 'undefined') return;
  captured = true;
  window.addEventListener('beforeinstallprompt', (event) => {
    // Without this the browser shows its own mini-infobar; the button is the invitation instead.
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => deferred !== null;

export async function installApp(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = deferred;
  if (!event) return 'unavailable';
  await event.prompt();
  const { outcome } = await event.userChoice;
  // A prompt can be shown once; after it, the browser fires a fresh event if it may ask again.
  deferred = null;
  notify();
  return outcome;
}

/** Whether this browser will offer to install AMO right now. */
export function useInstallAvailable(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
