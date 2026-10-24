import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ChoiceMenu } from './ChoiceMenu';

const OPTIONS = [
  { value: 'day', label: 'Last 24 hours' },
  { value: 'week', label: 'Last 7 days' },
  { value: 'all', label: 'All mail' },
] as const;

function renderMenu(onChange = vi.fn()) {
  render(<ChoiceMenu label="Show mail from" value="day" options={OPTIONS} onChange={onChange} />);
  return onChange;
}

describe('ChoiceMenu', () => {
  it('opens on the current choice and picks another', async () => {
    const onChange = renderMenu();
    const dots = screen.getByRole('button', { name: 'Show mail from' });
    expect(dots).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(dots);

    expect(dots).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'Last 24 hours' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('menuitemradio', { name: 'Last 24 hours' })).toHaveFocus();

    await userEvent.click(screen.getByRole('menuitemradio', { name: 'All mail' }));

    expect(onChange).toHaveBeenCalledWith('all');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(dots).toHaveFocus();
  });

  // A keyboard is never stranded inside the list.
  it('moves with the arrow keys and closes on Escape', async () => {
    const onChange = renderMenu();
    await userEvent.click(screen.getByRole('button', { name: 'Show mail from' }));

    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitemradio', { name: 'Last 7 days' })).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    expect(screen.getByRole('menuitemradio', { name: 'All mail' })).toHaveFocus();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show mail from' })).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('closes when someone clicks elsewhere', async () => {
    renderMenu();
    await userEvent.click(screen.getByRole('button', { name: 'Show mail from' }));

    await userEvent.click(document.body);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
