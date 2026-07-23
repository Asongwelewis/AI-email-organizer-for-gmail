import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LoginPage } from './LoginPage';

const authState = vi.hoisted(() => ({
  isAuthenticated: false,
  isLoading: false,
  isRedirecting: false,
  login: vi.fn(),
}));

vi.mock('@web/context/useAuth', () => ({ useAuth: () => authState }));

function renderLogin(entry = '/login') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/dashboard" element={<div>Dashboard destination</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    authState.isAuthenticated = false;
    authState.isLoading = false;
    authState.isRedirecting = false;
    authState.login.mockReset();
  });

  it('renders MailMind branding, legal links, and the Google action', () => {
    renderLogin();
    expect(screen.getByRole('link', { name: 'MailMind AI home' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toBeInTheDocument();
  });

  it('starts backend Google login from the semantic action', async () => {
    const user = userEvent.setup();
    renderLogin();
    await user.click(screen.getByRole('button', { name: 'Continue with Google' }));
    expect(authState.login).toHaveBeenCalledTimes(1);
  });

  it('disables repeat clicks while redirecting', () => {
    authState.isRedirecting = true;
    renderLogin();
    expect(screen.getByRole('button', { name: 'Opening Google…' })).toBeDisabled();
  });

  it('shows only an allowlisted safe login error', () => {
    renderLogin('/login?status=login_failed&error=database-secret');
    expect(screen.getByRole('alert')).toHaveTextContent('Google sign-in could not be completed');
    expect(screen.queryByText('database-secret')).not.toBeInTheDocument();
  });

  it('redirects an authenticated user to the dashboard', () => {
    authState.isAuthenticated = true;
    renderLogin();
    expect(screen.getByText('Dashboard destination')).toBeInTheDocument();
  });
});
