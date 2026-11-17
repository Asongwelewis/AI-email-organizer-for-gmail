import { createReactErrorHandler } from './instrument';

import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { App } from './App';
import { captureInstallPrompt } from '@web/lib/installPrompt';
import { IN_ISLAND_APP, islandApp } from '@web/lib/islandApp';
import { retryWhenUnreachable, unreachableRetryDelay } from '@web/lib/queryRetry';
// theme.css first: it defines every colour token the other two consume.
import '@web/styles/theme.css';
import '@web/styles/index.css';
import '@web/styles/app.css';

// Before anything renders: the browser offers installation once, early, and does not repeat it.
captureInstallPrompt();

/*
 * Inside the AMO Island desktop program the page is the island's see-through window, so it paints
 * no background of its own; and a link that leaves AMO — "Open in Gmail" — opens in the person's
 * own browser rather than inside a window the size of the island.
 */
if (IN_ISLAND_APP) {
  document.documentElement.classList.add('island-app');
  document.addEventListener(
    'click',
    (event) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(link instanceof HTMLAnchorElement)) return;
      const leaves = link.target === '_blank' || link.origin !== window.location.origin;
      if (!leaves || event.defaultPrevented) return;
      event.preventDefault();
      islandApp.openExternal(link.href);
    },
    true,
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      // Only a server that never answered is asked again; see lib/queryRetry.ts.
      retry: retryWhenUnreachable,
      retryDelay: unreachableRetryDelay,
    },
  },
});

const reportReactError = createReactErrorHandler();
const rootOptions = reportReactError
  ? {
      onUncaughtError: reportReactError,
      onCaughtError: reportReactError,
      onRecoverableError: reportReactError,
    }
  : undefined;

ReactDOM.createRoot(document.getElementById('root') as HTMLElement, rootOptions).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
