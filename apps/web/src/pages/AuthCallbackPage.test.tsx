import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { AuthCallbackPage } from './AuthCallbackPage';

function renderCallback(entry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          <Route path="/dashboard" element={<div>Dashboard destination</div>} />
          <Route path="/login" element={<div>Login destination</div>} />
          <Route path="/settings/connections" element={<div>Connections destination</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AuthCallbackPage', () => {
  it('shows a safe success message without rendering callback secrets', () => {
    renderCallback(
      '/auth/callback?status=login_success&code=secret-code&access_token=secret-token',
    );

    expect(screen.getByRole('heading', { name: 'Welcome to MailMind.' })).toBeInTheDocument();
    expect(screen.queryByText(/secret-code|secret-token/)).not.toBeInTheDocument();
  });

  it('uses a generic message for unknown status values', () => {
    vi.useFakeTimers();
    renderCallback('/auth/callback?status=database_stack_trace');

    expect(
      screen.getByRole('heading', { name: 'We could not finish that step.' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('database_stack_trace')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('redirects login success to the dashboard after the transition', async () => {
    vi.useFakeTimers();
    renderCallback('/auth/callback?status=login_success');
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByText('Dashboard destination')).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('keeps Gmail denial in the authenticated connections flow', async () => {
    vi.useFakeTimers();
    renderCallback('/auth/callback?status=gmail_denied');
    expect(screen.getByRole('heading', { name: 'Gmail stayed private.' })).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByText('Connections destination')).toBeInTheDocument();
    vi.useRealTimers();
  });
});
