import { Link } from 'react-router-dom';

interface BrandMarkProps {
  compact?: boolean;
  inverted?: boolean;
}

/**
 * The AMO logo, drawn in the theme's own colours.
 *
 * The supplied artwork is white letters and a grey ring on black, which disappears on the light
 * theme. It is shipped as two transparent masks instead — the letters and the ring — and each is
 * painted with a CSS colour, so the mark is dark on light, light on dark, and inverted where asked,
 * from one source image. `compact` drops the spelled-out name beside it.
 */
export function BrandMark({ compact = false, inverted = false }: BrandMarkProps) {
  return (
    <Link
      className={`brand-mark ${inverted ? 'brand-mark--inverted' : ''}`}
      to="/"
      aria-label="AMO: Automated Mail Organizer — home"
    >
      <span className="brand-mark__symbol" aria-hidden="true">
        <span className="brand-mark__layer brand-mark__layer--ring" />
        <span className="brand-mark__layer brand-mark__layer--letters" />
      </span>
      {!compact && <span className="brand-mark__name">Automated Mail Organizer</span>}
    </Link>
  );
}
