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
  // Real numbers, with where they came from beside them.
  it('backs the classification claim with measured numbers and their source', () => {
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole('heading', { name: 'Made to classify. Built to organize.' }),
    ).toBeInTheDocument();
    expect(screen.getByText('11,244')).toBeInTheDocument();
    expect(screen.getByText('93%')).toBeInTheDocument();
    expect(screen.getByText(/Measured on a real 11,000-email Gmail inbox/)).toBeInTheDocument();
  });

  beforeAll(() => vi.stubGlobal('IntersectionObserver', IntersectionObserverStub));
  afterAll(() => vi.unstubAllGlobals());

  it('prominently names and clearly explains AMO', () => {
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>,
    );

    // The name is the logo itself, with the word for screen readers.
    expect(screen.getByRole('heading', { level: 1, name: 'AMO' })).toBeInTheDocument();
    expect(screen.getByText(/automated, classified mail organizer/i)).toBeInTheDocument();
    expect(screen.getByText(/classifies every email the moment it reaches/i)).toBeInTheDocument();
    // Everything is automatic now: nothing on the page asks anybody to review or approve.
    expect(
      screen.queryByText(/suggest|approve or reject|reviewed by you/i),
    ).not.toBeInTheDocument();
  });

  it('shows the complete four-step workflow', () => {
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole('heading', { name: 'Four steps. Two of them are yours.' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sign in with Google.' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Connect Gmail.' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your mail is classified.' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Organized into folders.' })).toBeInTheDocument();
    expect(screen.getByText(/last two years of your mail/i)).toBeInTheDocument();
  });
});
