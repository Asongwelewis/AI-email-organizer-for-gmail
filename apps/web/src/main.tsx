import { createReactErrorHandler } from './instrument';

import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { App } from './App';
import { captureInstallPrompt } from '@web/lib/installPrompt';
// theme.css first: it defines every colour token the other two consume.
import '@web/styles/theme.css';
import '@web/styles/index.css';
import '@web/styles/app.css';

// Before anything renders: the browser offers installation once, early, and does not repeat it.
captureInstallPrompt();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: false,
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
