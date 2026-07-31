import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';

import { TutorialExperience } from './TutorialExperience';
import { TUTORIAL_PROGRESS_KEY, tutorialSteps } from './tutorial.scenario';

const accountId = 'account-1';

function Harness({
  eligible,
  onComplete,
}: {
  eligible: boolean;
  onComplete: (decision: 'COMPLETED' | 'SKIPPED') => Promise<void>;
}) {
  const location = useLocation();
  return (
    <>
      <output aria-label="Current tutorial route">{location.pathname}</output>
      <nav data-tutorial="primary-navigation">Navigation</nav>
      <div data-tutorial="identity-card">Identity</div>
      <div data-tutorial="gmail-summary">Gmail summary</div>
      <div data-tutorial="connection-stage">Connection</div>
      <div data-tutorial="labels-hero">Labels</div>
      <div data-tutorial="automation-state">Automation status</div>
      <div data-tutorial="automation-run">Automation run</div>
      <div data-tutorial="automation-review">Automation review</div>
      <TutorialExperience accountId={accountId} eligible={eligible} onComplete={onComplete} />
    </>
  );
}

function renderTutorial({
  eligible = false,
  onComplete = vi.fn().mockResolvedValue(undefined),
}: {
  eligible?: boolean;
  onComplete?: (decision: 'COMPLETED' | 'SKIPPED') => Promise<void>;
} = {}) {
  render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Harness eligible={eligible} onComplete={onComplete} />
    </MemoryRouter>,
  );
  return { onComplete };
}

describe('TutorialExperience', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    Element.prototype.scrollIntoView = () => undefined;
  });

  it('starts automatically only for a new account', async () => {
    const newAccount = renderTutorial({ eligible: true });
    expect(
      await screen.findByRole('dialog', { name: 'Your inbox control room' }, { timeout: 1500 }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Skip tutorial' }));
    await waitFor(() => expect(newAccount.onComplete).toHaveBeenCalledWith('SKIPPED'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not automatically interrupt an existing account', async () => {
    renderTutorial({ eligible: false });
    await act(() => new Promise((resolve) => window.setTimeout(resolve, 950)));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('walks through routes and stores progress under the account id', async () => {
    renderTutorial();
    act(() => window.dispatchEvent(new Event('mailmind:start-tutorial')));

    expect(
      await screen.findByRole('dialog', { name: 'Your inbox control room' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    fireEvent.click(screen.getByRole('button', { name: /next/i }));

    await waitFor(() =>
      expect(screen.getByLabelText('Current tutorial route')).toHaveTextContent(
        '/settings/connections',
      ),
    );
    expect(screen.getByRole('dialog', { name: 'You control Gmail access' })).toBeInTheDocument();
    expect(window.sessionStorage.getItem(`${TUTORIAL_PROGRESS_KEY}:${accountId}`)).toBe('3');
  });

  it('supports back, keyboard navigation, skip, and manual restart', async () => {
    const completion = vi.fn().mockResolvedValue(undefined);
    renderTutorial({ onComplete: completion });
    act(() => window.dispatchEvent(new Event('mailmind:start-tutorial')));
    const dialog = await screen.findByRole('dialog');

    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(screen.getByRole('dialog', { name: 'MailMind login is separate' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' });
    expect(screen.getByRole('dialog', { name: 'Your inbox control room' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Skip tutorial' }));
    await waitFor(() => expect(completion).toHaveBeenCalledWith('SKIPPED'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    act(() => window.dispatchEvent(new Event('mailmind:start-tutorial')));
    expect(
      await screen.findByRole('dialog', { name: 'Your inbox control room' }),
    ).toBeInTheDocument();
  });

  it('persists completion after the final step and clears resumable progress', async () => {
    const completion = vi.fn().mockResolvedValue(undefined);
    renderTutorial({ onComplete: completion });
    act(() => window.dispatchEvent(new Event('mailmind:start-tutorial')));
    await screen.findByRole('dialog');

    for (let index = 1; index < tutorialSteps.length; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: /next/i }));
    }
    expect(screen.getByRole('dialog', { name: 'You are in control' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /finish/i }));

    await waitFor(() => expect(completion).toHaveBeenCalledWith('COMPLETED'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(`${TUTORIAL_PROGRESS_KEY}:${accountId}`)).toBeNull();
  });

  it('keeps the tutorial open if the account preference cannot be saved', async () => {
    renderTutorial({
      eligible: true,
      onComplete: vi.fn().mockRejectedValue(new Error('network unavailable')),
    });
    await screen.findByRole('dialog', { name: 'Your inbox control room' }, { timeout: 1500 });
    fireEvent.click(screen.getByRole('button', { name: 'Skip tutorial' }));

    expect(await screen.findByText(/tutorial preference could not be saved/i)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
