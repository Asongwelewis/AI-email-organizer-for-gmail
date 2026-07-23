interface AvatarProps {
  name: string | null;
  email: string;
  src: string | null;
  size?: 'small' | 'large';
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
  return src ? (
    <img
      className={className}
      src={src}
      alt={`${name ?? email} profile`}
      referrerPolicy="no-referrer"
    />
  ) : (
    <span className={className} role="img" aria-label={`${name ?? email} initials`}>
      {initials(name, email)}
    </span>
  );
}
