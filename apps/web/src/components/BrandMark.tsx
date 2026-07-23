import { Link } from 'react-router-dom';

interface BrandMarkProps {
  compact?: boolean;
  inverted?: boolean;
}

export function BrandMark({ compact = false, inverted = false }: BrandMarkProps) {
  return (
    <Link
      className={`brand-mark ${inverted ? 'brand-mark--inverted' : ''}`}
      to="/"
      aria-label="MailMind AI home"
    >
      <svg className="brand-mark__symbol" viewBox="0 0 44 44" aria-hidden="true">
        <path d="M4 9.5 22 22 40 9.5v25H4z" fill="currentColor" opacity=".16" />
        <path
          d="M4 9.5h36L22 22z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.3"
          strokeLinejoin="round"
        />
        <path
          d="M4 9.5v25h36v-25M4 34.5l13.2-16M40 34.5l-13.2-16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.3"
          strokeLinejoin="round"
        />
        <circle cx="34.5" cy="8.5" r="5.5" fill="var(--vermilion)" />
      </svg>
      {!compact && (
        <span className="brand-mark__name">
          MailMind <em>AI</em>
        </span>
      )}
    </Link>
  );
}
