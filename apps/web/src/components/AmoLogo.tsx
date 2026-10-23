/**
 * The AMO mark, painted in the theme's colours: the letters in the current ink, the ring a step
 * behind. Two transparent masks cut from the owner's artwork (see `public/brand/`), so one image
 * reads on cream and on graphite alike. Size it with `width` on the class or a wrapper.
 */
export function AmoLogo({ className }: { className?: string }) {
  return (
    <span className={`amo-logo${className ? ` ${className}` : ''}`} aria-hidden="true">
      <span className="amo-logo__layer amo-logo__layer--ring" />
      <span className="amo-logo__layer amo-logo__layer--letters" />
    </span>
  );
}
