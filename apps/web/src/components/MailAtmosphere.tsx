import { useEffect, useMemo, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { motion, useMotionValue, useReducedMotion, useSpring } from 'motion/react';
import { Outlet, useLocation } from 'react-router-dom';

const shapes = [
  'envelope',
  'route',
  'fold',
  'envelope',
  'stamp',
  'route',
  'fold',
  'envelope',
] as const;

function sceneForPath(pathname: string): 'landing' | 'auth' | 'app' | 'legal' {
  if (pathname === '/') return 'landing';
  if (pathname === '/login' || pathname === '/auth/callback') return 'auth';
  if (pathname === '/dashboard' || pathname.startsWith('/settings/')) return 'app';
  return 'legal';
}

export function VisualRoot() {
  return (
    <>
      <MailAtmosphere />
      <Outlet />
    </>
  );
}

export function MailAtmosphere() {
  const { pathname } = useLocation();
  const scene = useMemo(() => sceneForPath(pathname), [pathname]);
  const reduceMotion = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);
  const x = useSpring(pointerX, { stiffness: 55, damping: 24, mass: 0.9 });
  const y = useSpring(pointerY, { stiffness: 55, damping: 24, mass: 0.9 });

  useEffect(() => {
    const finePointer = window.matchMedia('(pointer: fine)').matches;
    if (!finePointer || reduceMotion || paused) {
      pointerX.set(0);
      pointerY.set(0);
      return;
    }

    const onPointerMove = (event: PointerEvent) => {
      pointerX.set(((event.clientX / window.innerWidth) * 2 - 1) * -10);
      pointerY.set(((event.clientY / window.innerHeight) * 2 - 1) * -7);
    };
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    return () => window.removeEventListener('pointermove', onPointerMove);
  }, [paused, pointerX, pointerY, reduceMotion]);

  const motionPaused = paused || Boolean(reduceMotion);

  return (
    <>
      <motion.div
        className={`mail-atmosphere${motionPaused ? ' is-paused' : ''}`}
        data-scene={scene}
        aria-hidden="true"
        style={{ x, y }}
      >
        {shapes.map((shape, index) => (
          <span className={`mail-shape mail-shape--${shape}`} key={`${shape}-${index}`}>
            <MailShape kind={shape} />
          </span>
        ))}
      </motion.div>
      {!reduceMotion && (
        <button
          className="motion-pause"
          type="button"
          aria-pressed={paused}
          aria-label={paused ? 'Resume background motion' : 'Pause background motion'}
          title={paused ? 'Resume background motion' : 'Pause background motion'}
          onClick={() => setPaused((value) => !value)}
        >
          {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
          <span>{paused ? 'Play motion' : 'Pause motion'}</span>
        </button>
      )}
    </>
  );
}

function MailShape({ kind }: { kind: (typeof shapes)[number] }) {
  if (kind === 'route') {
    return (
      <svg viewBox="0 0 180 120" fill="none">
        <path d="M14 96C42 30 95 112 166 22" stroke="currentColor" strokeDasharray="8 10" />
        <circle cx="14" cy="96" r="5" fill="currentColor" />
        <path d="m153 20 14 1-3 14" stroke="currentColor" />
      </svg>
    );
  }

  if (kind === 'fold') {
    return (
      <svg viewBox="0 0 160 120" fill="none">
        <path d="M18 102 80 18l62 84M18 102h124" stroke="currentColor" />
        <path d="m44 68 36 26 36-26" stroke="currentColor" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 170 120" fill="none">
      <rect
        x="13"
        y="18"
        width="144"
        height="88"
        rx={kind === 'stamp' ? 14 : 2}
        stroke="currentColor"
      />
      <path d="m16 23 69 52 69-52M16 102l48-45M154 102l-48-45" stroke="currentColor" />
      {kind === 'stamp' && <circle cx="142" cy="32" r="6" fill="currentColor" />}
    </svg>
  );
}
