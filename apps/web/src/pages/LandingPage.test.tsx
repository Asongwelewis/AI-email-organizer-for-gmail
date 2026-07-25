import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { LandingPage } from './LandingPage';

class IntersectionObserverStub {
  constructor(_callback: IntersectionObserverCallback) {}

  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('LandingPage', () => {
  beforeAll(() => vi.stubGlobal('IntersectionObserver', IntersectionObserverStub));
  afterAll(() => vi.unstubAllGlobals());

  it('prominently names and clearly explains MailMind AI', () => {
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { level: 1, name: 'MailMind AI' })).toBeInTheDocument();
    expect(screen.getByText(/securely analyzes synchronized Gmail metadata/i)).toBeInTheDocument();
  });

  it('shows the complete four-step workflow', () => {
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole('heading', { name: 'Four clear steps. Every choice stays yours.' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sign in with Google.' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Connect Gmail.' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Review suggested labels.' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Approve or reject suggestions.' }),
    ).toBeInTheDocument();
  });
});
