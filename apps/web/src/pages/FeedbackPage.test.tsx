import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FeedbackPage } from './FeedbackPage';
import { api } from '@web/services/http';

vi.mock('@web/services/http', () => ({
  api: { sendFeedback: vi.fn() },
}));

const sendFeedback = vi.mocked(api.sendFeedback);

const NOTE = 'Reconnecting Gmail does not clear GMAIL_REAUTH_REQUIRED on the Sorted screen.';

function renderPage(from = '/') {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/feedback', state: { from } }]}>
      <FeedbackPage />
    </MemoryRouter>,
  );
}

describe('FeedbackPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sendFeedback.mockResolvedValue(undefined);
  });

  /**
   * The point of the whole feature. Nothing on this page may require an account, because the people
   * best placed to say the app is confusing are the ones who never made one.
   */
  it('sends a note with no account and no contact address', async () => {
    const user = userEvent.setup();
    renderPage('/sorted');

    await user.type(screen.getByLabelText(/what happened/i), NOTE);
    await user.click(screen.getByRole('button', { name: /send feedback/i }));

    await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
    expect(sendFeedback).toHaveBeenCalledWith({
      kind: 'PROBLEM',
      message: NOTE,
      page: '/sorted',
    });
    // No `contact` key at all, rather than an empty one: they declined a reply.
    expect(Object.keys(sendFeedback.mock.calls[0]![0])).not.toContain('contact');
  });

  /**
   * Router state is whatever the previous navigation happened to put there. Coercing it with
   * `String()` turns a missing value into the literal "undefined", which the server rejects — so a
   * visitor who typed the URL in would have had their whole submission refused over a field that
   * only exists to make a report easier to place.
   */
  it('omits the originating route rather than inventing one', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/feedback']}>
        <FeedbackPage />
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText(/what happened/i), NOTE);
    await user.click(screen.getByRole('button', { name: /send feedback/i }));

    await waitFor(() => expect(sendFeedback).toHaveBeenCalledTimes(1));
    expect(Object.keys(sendFeedback.mock.calls[0]![0])).not.toContain('page');
  });

  it('strips a query string the caller left on the route', async () => {
    const user = userEvent.setup();
    renderPage('/find?q=my+bank+statement');

    await user.type(screen.getByLabelText(/what happened/i), NOTE);
    await user.click(screen.getByRole('button', { name: /send feedback/i }));

    await waitFor(() =>
      expect(sendFeedback).toHaveBeenCalledWith(expect.objectContaining({ page: '/find' })),
    );
  });

  it('passes on the address when one is offered', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/what happened/i), NOTE);
    await user.type(screen.getByLabelText(/your email/i), 'someone@example.com');
    await user.click(screen.getByRole('button', { name: /send feedback/i }));

    await waitFor(() =>
      expect(sendFeedback).toHaveBeenCalledWith(
        expect.objectContaining({ contact: 'someone@example.com' }),
      ),
    );
  });

  it('records which kind of note it is', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('radio', { name: /i have an idea/i }));
    await user.type(screen.getByLabelText(/what happened/i), NOTE);
    await user.click(screen.getByRole('button', { name: /send feedback/i }));

    await waitFor(() =>
      expect(sendFeedback).toHaveBeenCalledWith(expect.objectContaining({ kind: 'IDEA' })),
    );
  });

  /**
   * Caught here rather than at the server, and announced where a screen reader will read it: an
   * error that only exists at the top of the page is an error somebody typing in a textarea never
   * hears about.
   */
  it('refuses a note too short to act on, and says so beside the field', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/what happened/i), 'broken');
    await user.click(screen.getByRole('button', { name: /send feedback/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/at least 10 characters/i);
    expect(sendFeedback).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/what happened/i)).toHaveFocus();
  });

  it('confirms in place rather than navigating away', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/what happened/i), NOTE);
    await user.click(screen.getByRole('button', { name: /send feedback/i }));

    expect(await screen.findByRole('heading', { name: /sent\. thank you/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/what happened/i)).not.toBeInTheDocument();
  });

  /**
   * A failure has to leave the text where it was. Somebody who has just written four paragraphs
   * about what went wrong will not write them again.
   */
  it('keeps what was written when sending fails', async () => {
    sendFeedback.mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText(/what happened/i), NOTE);
    await user.click(screen.getByRole('button', { name: /send feedback/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText(/what happened/i)).toHaveValue(NOTE);
    expect(screen.getByRole('button', { name: /send feedback/i })).toBeEnabled();
  });
});
