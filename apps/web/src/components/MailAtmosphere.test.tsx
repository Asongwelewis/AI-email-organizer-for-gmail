import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { MailAtmosphere } from './MailAtmosphere';

function renderAtmosphere(pathname = '/') {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <Routes>
        <Route path="*" element={<MailAtmosphere />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('MailAtmosphere', () => {
  it('uses a calmer scene on authentication routes', () => {
    const { container } = renderAtmosphere('/login');
    expect(container.querySelector('[data-scene="auth"]')).toBeInTheDocument();
    expect(container.querySelectorAll('.mail-shape')).toHaveLength(8);
  });

  it('allows continuous decorative motion to be paused and resumed', async () => {
    const user = userEvent.setup();
    renderAtmosphere();

    await user.click(screen.getByRole('button', { name: 'Pause background motion' }));
    expect(screen.getByRole('button', { name: 'Resume background motion' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
