import { Monitor, Moon, Sun } from 'lucide-react';

import { useTheme, type ThemePreference } from '@web/context/useTheme';

/**
 * The macOS segmented control: three mutually exclusive options, all visible, one filled.
 *
 * A cycling icon-only button would be smaller, and it would also never tell you what the other
 * two options are or which one you are on when the OS happens to agree with your override.
 */
const OPTIONS: Array<{ value: ThemePreference; label: string; Icon: typeof Sun }> = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'Auto', Icon: Monitor },
];

export interface ThemeToggleProps {
  /** `compact` drops the text labels where there is no room for them. */
  variant?: 'default' | 'compact';
  className?: string;
}

export function ThemeToggle({ variant = 'default', className }: ThemeToggleProps) {
  const { preference, setPreference } = useTheme();

  return (
    <div
      className={`theme-toggle theme-toggle--${variant}${className ? ` ${className}` : ''}`}
      role="group"
      aria-label="Colour theme"
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          className={`theme-toggle__option${
            preference === value ? ' theme-toggle__option--active' : ''
          }`}
          // aria-pressed, not aria-checked: these are toggle buttons in a group, not radios in a
          // form, and a screen reader has to be able to say which one is on.
          aria-pressed={preference === value}
          onClick={() => setPreference(value)}
        >
          <Icon aria-hidden="true" strokeWidth={1.6} />
          {variant === 'compact' ? <span className="sr-only">{label}</span> : <span>{label}</span>}
        </button>
      ))}
    </div>
  );
}
