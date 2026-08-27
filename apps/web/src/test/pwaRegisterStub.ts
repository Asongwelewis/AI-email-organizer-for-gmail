/**
 * Stands in for `virtual:pwa-register/react`, which only exists inside a Vite build. Tests render
 * the app without a service worker, so registration is a no-op that never asks to refresh.
 */
export function useRegisterSW() {
  return {
    needRefresh: [false, () => undefined] as [boolean, (value: boolean) => void],
    offlineReady: [false, () => undefined] as [boolean, (value: boolean) => void],
    updateServiceWorker: () => Promise.resolve(),
  };
}
