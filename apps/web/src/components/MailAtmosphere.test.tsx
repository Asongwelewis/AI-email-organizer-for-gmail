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
    expect(container.querySelectorAll('.mail-shape')).toHaveLength(12);
  });

  // Plenty of them on the landing page, each on its own path: no two share a start and pace.
  it('scatters a larger field of envelopes, each on its own random path', () => {
    const { container } = renderAtmosphere('/');
    const shapes = [...container.querySelectorAll<HTMLElement>('.mail-shape')];
    expect(shapes).toHaveLength(24);
    const paths = new Set(
      shapes.map((shape) => `${shape.style.left}|${shape.style.animationDuration}`),
    );
    expect(paths.size).toBe(24);
    expect(shapes[0]!.style.getPropertyValue('--x1')).toMatch(/vw$/);
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
