import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, MoreVertical } from 'lucide-react';

export interface ChoiceMenuProps<T extends string> {
  /** Names the button for a screen reader, and heads the open menu. */
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}

/**
 * A choice that is changed now and then, kept behind three dots instead of a box on the screen.
 *
 * The open list is an ARIA menu of radio items: arrow keys move, Enter or a click picks, Escape and
 * a click anywhere else close it and hand focus back to the dots, so a keyboard is never stranded.
 */
export function ChoiceMenu<T extends string>({
  label,
  value,
  options,
  onChange,
}: ChoiceMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const selected = Math.max(
      0,
      options.findIndex((option) => option.value === value),
    );
    itemRefs.current[selected]?.focus();

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, options, value]);

  const onMenuKeyDown = (event: KeyboardEvent) => {
    const items = itemRefs.current.filter((item): item is HTMLButtonElement => item !== null);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className="choice-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`choice-menu__button${open ? ' choice-menu__button--open' : ''}`}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <MoreVertical aria-hidden="true" strokeWidth={1.75} />
      </button>
      {open ? (
        <div
          id={menuId}
          className="choice-menu__list"
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
        >
          <p className="choice-menu__heading" aria-hidden="true">
            {label}
          </p>
          {options.map((option, index) => {
            const checked = option.value === value;
            return (
              <button
                key={option.value}
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                className={`choice-menu__item${checked ? ' choice-menu__item--checked' : ''}`}
                onClick={() => {
                  onChange(option.value);
                  close(true);
                }}
              >
                <span>{option.label}</span>
                {checked ? <Check aria-hidden="true" strokeWidth={2} /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
