import { forwardRef, type ComponentProps, type ReactNode } from 'react';
import { motion, useMotionValue, useSpring } from 'motion/react';

interface MagneticButtonProps extends Omit<
  ComponentProps<typeof motion.button>,
  'children' | 'style'
> {
  children: ReactNode;
  variant?: 'ink' | 'paper' | 'outline' | 'danger';
}

export const MagneticButton = forwardRef<HTMLButtonElement, MagneticButtonProps>(
  function MagneticButton(
    { children, className = '', variant = 'ink', onPointerMove, onPointerLeave, ...props },
    ref,
  ) {
    const x = useMotionValue(0);
    const y = useMotionValue(0);
    const springX = useSpring(x, { stiffness: 260, damping: 18 });
    const springY = useSpring(y, { stiffness: 260, damping: 18 });

    return (
      <motion.button
        ref={ref}
        className={`magnetic-button magnetic-button--${variant} ${className}`}
        style={{ x: springX, y: springY }}
        whileTap={{ scale: 0.97 }}
        onPointerMove={(event) => {
          if (event.pointerType === 'mouse') {
            const bounds = event.currentTarget.getBoundingClientRect();
            x.set((event.clientX - bounds.left - bounds.width / 2) * 0.16);
            y.set((event.clientY - bounds.top - bounds.height / 2) * 0.16);
          }
          onPointerMove?.(event);
        }}
        onPointerLeave={(event) => {
          x.set(0);
          y.set(0);
          onPointerLeave?.(event);
        }}
        {...props}
      >
        <span>{children}</span>
      </motion.button>
    );
  },
);
