import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { sharpAvatarUrl } from '@web/lib/avatarUrl';
import { Avatar } from './Avatar';

describe('Avatar', () => {
  it('asks Google for a photo sharp enough for the side panel', () => {
    expect(sharpAvatarUrl('https://lh3.googleusercontent.com/a/abc=s96-c')).toBe(
      'https://lh3.googleusercontent.com/a/abc=s256-c',
    );
    // Anything that is not a Google photo is left exactly as it came.
    expect(sharpAvatarUrl('https://example.com/me.png')).toBe('https://example.com/me.png');
  });

  // A broken-image icon where a face should be is worse than the initials.
  it('falls back to the initials when the photo will not load', () => {
    render(
      <Avatar
        name="Ada Lovelace"
        email="ada@example.com"
        src="https://lh3.googleusercontent.com/a/abc=s96-c"
      />,
    );

    fireEvent.error(screen.getByRole('img', { name: 'Ada Lovelace profile' }));

    expect(screen.getByRole('img', { name: 'Ada Lovelace initials' })).toHaveTextContent('AL');
  });
});
