import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FolderTile } from './FolderTile';

function renderTile(iconUrl?: string | null) {
  return render(
    <FolderTile
      name="Netflix"
      path="MailMind/Netflix"
      count={12}
      childCount={0}
      iconUrl={iconUrl ?? null}
      onOpen={vi.fn()}
    />,
  );
}

describe('a folder tile', () => {
  it('shows the brand logo when there is one', () => {
    const { container } = renderTile('https://api.mailmindai.tech/api/facets/icons/netflix.com');

    const logo = container.querySelector('img');
    expect(logo).toHaveAttribute('src', 'https://api.mailmindai.tech/api/facets/icons/netflix.com');
    // Decorative: the name below already says whose mail it is, so it is not read out twice.
    expect(logo).toHaveAttribute('alt', '');
    expect(screen.getByText('Netflix')).toBeInTheDocument();
  });

  // A broken image is worse than no image: a logo that fails to load gives way to the folder icon.
  it('falls back to the folder icon when the logo cannot be loaded', () => {
    const { container } = renderTile('https://api.mailmindai.tech/api/facets/icons/unknown.io');

    fireEvent.error(container.querySelector('img')!);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg.folder-tile__icon')).not.toBeNull();
  });

  it('keeps the folder icon for folders that are not a brand', () => {
    const { container } = renderTile(null);

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg.folder-tile__icon')).not.toBeNull();
  });
});
