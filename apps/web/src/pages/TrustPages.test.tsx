import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AboutPage } from './AboutPage';
import { CookiesPage } from './CookiesPage';
import { FaqPage } from './FaqPage';
import { SecurityPage } from './SecurityPage';

function renderPage(page: React.ReactNode) {
  return render(<MemoryRouter>{page}</MemoryRouter>);
}

describe('public trust surfaces', () => {
  it('explains the product boundary on the about page', () => {
    renderPage(<AboutPage />);

    expect(screen.getByRole('heading', { name: 'About MailMind' })).toBeInTheDocument();
    expect(
      screen.getByText(/does not send mail, answer mail, or silently change/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /privacy policy/i })).toBeInTheDocument();
  });

  it('keeps FAQ answers collapsed until a visitor asks', () => {
    renderPage(<FaqPage />);

    const question = screen.getByText('Does MailMind read my email body or attachments?');
    const details = question.closest('details');
    expect(details).not.toHaveAttribute('open');
    fireEvent.click(question);
    expect(details).toHaveAttribute('open');
    expect(screen.getByText(/does not request or store raw MIME/i)).toBeVisible();
  });

  it('states the browser and credential security boundary', () => {
    renderPage(<SecurityPage />);

    expect(screen.getByText(/Read-only by default/i)).toBeInTheDocument();
    expect(screen.getByText(/never sent to the browser/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot override that browser-level authority/i)).toBeInTheDocument();
  });

  it('documents that local storage contains preferences only', () => {
    renderPage(<CookiesPage />);

    expect(screen.getByRole('heading', { name: 'Cookies and local storage' })).toBeInTheDocument();
    expect(
      screen.getByText(/No access token, refresh token, message, or account secret/i),
    ).toBeInTheDocument();
  });
});
