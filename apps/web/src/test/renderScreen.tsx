import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { ThemeProvider } from '@web/context/ThemeContext';

/**
 * Screens under test get a fresh cache and no retries, so a failure surfaces on the first pass.
 *
 * `ThemeProvider` is here rather than in each test because it is part of the application shell in
 * `App.tsx`: anything rendering a themed control needs it, and a test that has to remember to add
 * a provider is a test that will one day forget.
 */
export function renderScreen(ui: ReactElement, initialEntry = '/') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialEntry]}>{ui}</MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

/** An axios-shaped rejection, so the screen's error handling sees what the client would give it. */
export function apiError(code: string, message: string, status = 400) {
  return Object.assign(new Error(message), {
    isAxiosError: true,
    toJSON: () => ({}),
    response: { status, data: { error: { code, message } } },
  });
}
