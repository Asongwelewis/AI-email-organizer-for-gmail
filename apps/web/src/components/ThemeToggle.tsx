import { Download, Moon, Sun } from 'lucide-react';

import { useTheme, type ResolvedTheme } from '@web/context/useTheme';
import { installApp, useInstallAvailable } from '@web/lib/installPrompt';

/**
 * The macOS segmented control: light or dark, both visible, one filled — and, where the browser
 * allows it, a third segment that installs AMO as an app.
 *
 * The "Auto" option is gone from the control. A stored `system` preference from before still
 * works; the control simply shows whichever theme it resolved to.
 */
const OPTIONS: Array<{ value: ResolvedTheme; label: string; Icon: typeof Sun }> = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
];

export interface ThemeToggleProps {
  /** `compact` drops the text labels where there is no room for them. */
  variant?: 'default' | 'compact';
  className?: string;
}

export function ThemeToggle({ variant = 'default', className }: ThemeToggleProps) {
  const { resolvedTheme, setPreference } = useTheme();
  const installable = useInstallAvailable();

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
            resolvedTheme === value ? ' theme-toggle__option--active' : ''
          }`}
          // aria-pressed, not aria-checked: these are toggle buttons in a group, not radios in a
          // form, and a screen reader has to be able to say which one is on.
          aria-pressed={resolvedTheme === value}
          onClick={() => setPreference(value)}
        >
          <Icon aria-hidden="true" strokeWidth={1.6} />
          {variant === 'compact' ? <span className="sr-only">{label}</span> : <span>{label}</span>}
        </button>
      ))}
      {installable ? (
        <button
          type="button"
          className="theme-toggle__option theme-toggle__option--install"
          title="Install AMO as an app"
          onClick={() => void installApp()}
        >
          <Download aria-hidden="true" strokeWidth={1.6} />
          {variant === 'compact' ? (
            <span className="sr-only">Install app</span>
          ) : (
            <span>Install app</span>
          )}
        </button>
      ) : null}
    </div>
  );
}
