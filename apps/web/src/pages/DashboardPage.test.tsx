import { render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { DashboardPage } from './DashboardPage';

const authState = vi.hoisted(() => ({
  user: {
    id: 'user-1',
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    avatarUrl: null,
    status: 'ACTIVE' as const,
    gmailConnected: false,
  },
  gmailConnection: {
    connected: false,
    email: null,
    status: 'DISCONNECTED' as const,
    grantedScopes: [],
    requiresReauthentication: false,
  },
  logout: vi.fn(),
}));

vi.mock('@web/context/useAuth', () => ({ useAuth: () => authState }));

describe('DashboardPage', () => {
  it('renders real identity data, avatar fallback, and Gmail summary without fake statistics', () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route element={<Outlet context={{ openLogoutAll: vi.fn() }} />}>
            <Route path="/dashboard" element={<DashboardPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Ada Lovelace initials' })).toHaveTextContent('AL');
    expect(screen.getByRole('heading', { name: 'Gmail stays separate' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Inbox organization, labels, and analysis are intentionally not active yet.',
      ),
    ).toBeInTheDocument();
  });
});
