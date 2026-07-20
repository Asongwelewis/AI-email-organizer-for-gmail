import { useEffect, useState } from 'react';
import { motion, useMotionValue, useSpring } from 'motion/react';

export function CustomCursor() {
  const x = useMotionValue(-40);
  const y = useMotionValue(-40);
  const springX = useSpring(x, { stiffness: 520, damping: 38, mass: 0.2 });
  const springY = useSpring(y, { stiffness: 520, damping: 38, mass: 0.2 });
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!window.matchMedia('(pointer: fine)').matches) return;
    const onMove = (event: PointerEvent) => {
      x.set(event.clientX - 8);
      y.set(event.clientY - 8);
    };
    const onOver = (event: PointerEvent) => {
      setActive(Boolean((event.target as HTMLElement).closest('a,button,[data-cursor]')));
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerover', onOver, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerover', onOver);
    };
  }, [x, y]);

  return (
    <motion.div
      className="custom-cursor"
      aria-hidden="true"
      style={{ x: springX, y: springY }}
      animate={{ scale: active ? 2.7 : 1, opacity: active ? 0.55 : 0.8 }}
      transition={{ duration: 0.18 }}
    />
  );
}
