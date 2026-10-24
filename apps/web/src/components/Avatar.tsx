import { useEffect, useState } from 'react';

import { sharpAvatarUrl } from '@web/lib/avatarUrl';

interface AvatarProps {
  name: string | null;
  email: string;
  src: string | null;
  size?: 'small' | 'medium' | 'large';
}

function initials(name: string | null, email: string): string {
  const source = name?.trim() || email.split('@')[0] || 'M';
  return source
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

export function Avatar({ name, email, src, size = 'small' }: AvatarProps) {
  const className = `avatar avatar--${size}`;
  // A photo that will not load becomes the initials, never a broken-image icon.
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);

  return src && !failed ? (
    <img
      className={className}
      src={sharpAvatarUrl(src)}
      alt={`${name ?? email} profile`}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  ) : (
    <span className={className} role="img" aria-label={`${name ?? email} initials`}>
      {initials(name, email)}
    </span>
  );
}
