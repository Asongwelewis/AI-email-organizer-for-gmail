import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import {
  AnimatePresence,
  motion,
  useDragControls,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useSpring,
  useTransform,
  type MotionValue,
} from 'motion/react';
import { X } from 'lucide-react';
import { NavLink, useLocation, useMatch } from 'react-router-dom';

import { Avatar } from '@web/components/Avatar';
import { IslandPanel } from '@web/components/app/IslandWindow';
import { useIslandFrame, type Placement } from '@web/components/app/islandFrame';
import { MenuButton } from '@web/components/app/MenuButton';
import {
  ISLAND_PANEL_TITLE_ID,
  ISLAND_WINDOW_ID,
  modalOpen,
  type IslandView,
  type NavDestination,
} from '@web/components/app/islandWindowState';
import { useAuth } from '@web/context/useAuth';
import { islandApp } from '@web/lib/islandApp';
import { DOCK, useIslandTransition, usePopIn } from '@web/lib/motion';
import { SLOW_SERVER_MESSAGE, useServerWaking } from '@web/lib/serverWaking';

/** What the tray shows: the screen the island opened, or one of the menu's views. */
type Tray = 'screen' | IslandView;

const POSITION_KEY = 'amo:island-position';
/** Kept clear between the island or its tray and the window's edges. */
const EDGE = 12;
/** Between the island and its tray. */
const GAP = 10;
const TRAY_MAX_WIDTH = 640;
/** Where the installed app opens. Nothing is asked for yet, so the tray starts closed. */
const START_PATH = '/inbox';

const OTHER_TITLES: Record<string, string> = {
  '/notifications': 'Notifications',
  '/account': 'Account & privacy',
  '/setup': 'Set up',
  '/menu': 'Menu',
};

/** Where the island was left, as an offset from its starting place at the top centre. */
function readPosition(): { x: number; y: number } {
  try {
    const saved = JSON.parse(window.localStorage.getItem(POSITION_KEY) ?? 'null') as {
      x?: unknown;
      y?: unknown;
    } | null;
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
      if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) return { x: saved.x, y: saved.y };
    }
  } catch {
    // Storage blocked or unreadable: start in the middle.
  }
  return { x: 0, y: 0 };
}

function savePosition(x: number, y: number) {
  try {
    window.localStorage.setItem(
      POSITION_KEY,
      JSON.stringify({ x: Math.round(x), y: Math.round(y) }),
    );
  } catch {
    // Remembering the place is a convenience; losing it costs nothing.
  }
}

/** The strip Chrome leaves for the window controls when the title bar is folded into the app. */
function titleBarHeight(): number {
  const overlay = (
    navigator as Navigator & {
      windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): DOMRect };
    }
  ).windowControlsOverlay;
  return overlay?.visible ? overlay.getTitlebarAreaRect().height : 0;
}

/**
 * The installed desktop app's island: a dark pill floating over an otherwise empty window, which
 * can be dragged anywhere and stays where it was left. The menu, the five screens and the account
 * photo sit on it; tapping one opens a small tray from the island with that screen in it, instead
 * of the whole window turning into the screen.
 *
 * The tray opens towards the middle of the window — below the island near the top, above it near
 * the bottom — and follows the island while it is dragged. The screens move like the Mac's Dock:
 * they swell and lift as the pointer passes across them.
 *
 * `companion` is the AMO Island desktop program, where the window *is* the island and sits on the
 * Windows desktop: dragging moves the window itself, the window grows around a tray and shrinks
 * back (`useIslandFrame`), and clicking anywhere else on the desktop puts the tray away.
 */
export function DesktopIsland({
  destinations,
  screen,
  onSignOut,
  companion = false,
}: {
  destinations: readonly NavDestination[];
  screen: ReactNode;
  onSignOut: () => void;
  companion?: boolean;
}) {
  const { user } = useAuth();
  const location = useLocation();
  const place = `${location.pathname}${location.search}`;
  const [tray, setTray] = useState<Tray | null>(() =>
    location.pathname === START_PATH && !location.search ? null : 'screen',
  );
  const islandRef = useRef<HTMLDivElement>(null);
  const [ownPlacement, setPlacement] = useState<Placement>('below');
  const [start] = useState(() => (companion ? { x: 0, y: 0 } : readPosition()));
  const x = useMotionValue(start.x);
  const y = useMotionValue(start.y);
  const islandHeight = useCallback(() => islandRef.current?.offsetHeight ?? 54, []);
  const onShift = useCallback((shift: number) => x.set(shift), [x]);
  const framePlacement = useIslandFrame(companion, tray !== null, islandHeight, onShift);
  const placement = companion ? framePlacement : ownPlacement;
  const placementRef = useRef(placement);
  placementRef.current = placement;
  const press = useRef<{ x: number; y: number } | null>(null);
  const controls = useDragControls();
  const trayRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const dragged = useRef(false);
  const transition = useIslandTransition();
  const reduceMotion = useReducedMotion();
  const waking = useServerWaking();
  const pop = usePopIn(placement === 'below' ? 'above' : 'below');

  const open = useCallback((next: Tray) => {
    const active = document.activeElement;
    opener.current = active instanceof HTMLElement ? active : null;
    setTray(next);
  }, []);

  const close = useCallback((restoreFocus = true) => {
    setTray(null);
    if (restoreFocus) opener.current?.focus();
  }, []);

  // Going somewhere — a link inside the tray, the back button, a notification — shows it.
  const lastPlace = useRef(place);
  useEffect(() => {
    if (lastPlace.current === place) return;
    lastPlace.current = place;
    setTray('screen');
  }, [place]);

  /** Puts the tray beside the island, on the side with room, and inside the window. */
  const arrange = useCallback(() => {
    const island = islandRef.current;
    if (!island) return;
    const box = island.getBoundingClientRect();
    const width = window.innerWidth;
    const height = window.innerHeight;
    const below = companion
      ? placementRef.current === 'below'
      : (box.top + box.bottom) / 2 < height / 2;
    if (!companion) setPlacement(below ? 'below' : 'above');

    const panel = trayRef.current;
    if (!panel) return;
    const trayWidth = Math.min(TRAY_MAX_WIDTH, width - 2 * EDGE);
    const centre = (box.left + box.right) / 2;
    const left = Math.min(Math.max(centre - trayWidth / 2, EDGE), width - EDGE - trayWidth);
    panel.style.setProperty('--tray-left', `${left}px`);
    panel.style.setProperty('--tray-width', `${trayWidth}px`);
    panel.style.setProperty('--tray-top', below ? `${box.bottom + GAP}px` : 'auto');
    panel.style.setProperty('--tray-bottom', below ? 'auto' : `${height - box.top + GAP}px`);
    panel.style.setProperty(
      '--tray-max-height',
      `${Math.max(160, below ? height - box.bottom - GAP - EDGE : box.top - GAP - EDGE)}px`,
    );
  }, [companion]);

  /** A place remembered from a bigger window, or a window that shrank: pull the island back in. */
  const keepInside = useCallback(() => {
    const island = islandRef.current;
    if (!island || companion) return;
    const box = island.getBoundingClientRect();
    const top = titleBarHeight() + EDGE;
    let dx = 0;
    let dy = 0;
    if (box.left < EDGE) dx = EDGE - box.left;
    else if (box.right > window.innerWidth - EDGE) dx = window.innerWidth - EDGE - box.right;
    if (box.top < top) dy = top - box.top;
    else if (box.bottom > window.innerHeight - EDGE) dy = window.innerHeight - EDGE - box.bottom;
    if (dx !== 0 || dy !== 0) {
      x.set(x.get() + dx);
      y.set(y.get() + dy);
      savePosition(x.get(), y.get());
    }
  }, [companion, x, y]);

  useEffect(() => {
    const onResize = () => {
      keepInside();
      // After the island has moved, so the tray is placed against where it now is.
      requestAnimationFrame(arrange);
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [arrange, keepInside]);

  // The tray rides along while the island is dragged.
  useMotionValueEvent(x, 'change', arrange);
  useMotionValueEvent(y, 'change', arrange);
  useLayoutEffect(() => {
    if (tray) arrange();
  }, [tray, arrange]);

  // Escape or a click on the empty window puts the tray away.
  useEffect(() => {
    if (!tray) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !modalOpen()) close();
    };
    const onPointerDown = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element) || modalOpen()) return;
      if (trayRef.current?.contains(target) || islandRef.current?.contains(target)) return;
      // A toast is not the window behind.
      if (target.closest('[data-sonner-toaster]')) return;
      close(false);
    };
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [tray, close]);

  // On the desktop, a click anywhere else lands in another program: the island's window loses
  // focus, and the tray goes away as it would for a click on the empty window.
  useEffect(() => {
    if (!companion || !tray) return;
    const onBlur = () => close(false);
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [close, companion, tray]);

  // Each tray is announced by name and starts at its top.
  useEffect(() => {
    if (tray) trayRef.current?.focus();
  }, [tray]);

  /** The open screen taps closed; another one opens in the tray. */
  const onScreen = useCallback(
    (event: ReactMouseEvent, active: boolean) => {
      if (!active) {
        open('screen');
        return;
      }
      event.preventDefault();
      if (tray === 'screen') close(false);
      else open('screen');
    },
    [close, open, tray],
  );

  const toggleMenu = () => {
    if (tray === 'home' || tray === 'notifications') close();
    else open('home');
  };
  const toggleAccount = () => {
    if (tray === 'account') close();
    else open('account');
  };

  if (!user) return null;

  const screenTitle =
    destinations.find(({ to }) => location.pathname.startsWith(to))?.label ??
    OTHER_TITLES[location.pathname] ??
    'AMO';

  return (
    <>
      {/* The window behind the island, and the box the island may be dragged within. On the
          desktop there is no window behind it: the desktop is. */}
      {companion ? null : (
        <div ref={stageRef} className="desk-stage">
          {tray ? null : (
            <p className="desk-stage__hint">
              Choose a screen on the island. Drag the island anywhere you like.
            </p>
          )}
        </div>
      )}

      <motion.div
        ref={islandRef}
        className={`desk-island desk-island--${placement}`}
        drag={!companion}
        dragControls={controls}
        dragListener={false}
        dragMomentum={false}
        dragElastic={0}
        dragConstraints={stageRef}
        style={{ x, y }}
        onDragStart={() => {
          dragged.current = true;
        }}
        onDragEnd={() => {
          savePosition(x.get(), y.get());
          arrange();
          // The click that ends a drag is not a tap on whatever it ended over.
          window.setTimeout(() => {
            dragged.current = false;
          }, 0);
        }}
      >
        <nav
          className="desk-island__bar"
          aria-label="Primary"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            if (!companion) {
              controls.start(event);
              return;
            }
            dragged.current = false;
            press.current = { x: event.clientX, y: event.clientY };
          }}
          onPointerMove={(event) => {
            // On the desktop Windows moves the window: past a few pixels the press becomes a drag
            // and the pointer is handed over, so a tap still taps.
            const from = press.current;
            if (!companion || !from || (event.buttons & 1) === 0) return;
            if (Math.hypot(event.clientX - from.x, event.clientY - from.y) < 4) return;
            press.current = null;
            dragged.current = true;
            islandApp.startDragging();
          }}
          onPointerUp={() => {
            press.current = null;
          }}
          onClickCapture={(event) => {
            if (!dragged.current) return;
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <MenuButton
            className="island__button"
            expanded={tray === 'home' || tray === 'notifications'}
            onToggle={toggleMenu}
          />
          <span className="island__divider" aria-hidden="true" />
          <Dock destinations={destinations} placement={placement} onScreen={onScreen} />
          <span className="island__divider" aria-hidden="true" />
          <button
            type="button"
            className="island__button island__avatar"
            data-island-trigger
            aria-haspopup="dialog"
            aria-expanded={tray === 'account'}
            aria-controls={tray === 'account' ? ISLAND_WINDOW_ID : undefined}
            aria-label="Account and privacy"
            title={user.displayName ?? user.email}
            onClick={toggleAccount}
          >
            <Avatar name={user.displayName} email={user.email} src={user.avatarUrl} />
          </button>
        </nav>
        <AnimatePresence initial={false}>
          {waking ? (
            <motion.div
              key="waking"
              className="island__live"
              initial={reduceMotion ? false : { height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
              transition={transition}
            >
              <p role="status" aria-live="polite">
                {SLOW_SERVER_MESSAGE}
              </p>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.div>

      <AnimatePresence>
        {tray ? (
          <motion.div
            key="tray"
            ref={trayRef}
            id={ISLAND_WINDOW_ID}
            className={`desk-tray desk-tray--${placement}`}
            role="dialog"
            aria-label={tray === 'screen' ? screenTitle : undefined}
            aria-labelledby={tray === 'screen' ? undefined : ISLAND_PANEL_TITLE_ID}
            tabIndex={-1}
            {...pop}
          >
            {tray === 'screen' ? (
              <div className="desk-tray__screen">
                <button
                  type="button"
                  className="island-window__tool desk-tray__close"
                  onClick={() => close()}
                  aria-label="Close"
                  title="Close"
                >
                  <X aria-hidden="true" strokeWidth={1.75} />
                </button>
                {screen}
              </div>
            ) : (
              <IslandPanel
                view={tray}
                onShow={setTray}
                onClose={close}
                onSignOut={() => {
                  if (!companion) close(false);
                  onSignOut();
                }}
              />
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

/**
 * The five screens as the Mac's Dock draws apps: icons that swell as the pointer passes across
 * them, the one under it most and its neighbours a little, each lifting towards the middle of the
 * window. The name shows beside the icon under the pointer, and a dot marks the screen that is
 * open. Only a mouse magnifies — a tap has nothing to pass across — and nothing moves under
 * reduced motion.
 */
function Dock({
  destinations,
  placement,
  onScreen,
}: {
  destinations: readonly NavDestination[];
  placement: Placement;
  onScreen: (event: ReactMouseEvent, active: boolean) => void;
}) {
  const pointer = useMotionValue(Number.POSITIVE_INFINITY);
  const reduceMotion = useReducedMotion();
  return (
    <ul
      className="dock"
      onPointerMove={(event) => {
        if (event.pointerType === 'mouse' && !reduceMotion) pointer.set(event.clientX);
      }}
      onPointerLeave={() => pointer.set(Number.POSITIVE_INFINITY)}
    >
      {destinations.map((destination) => (
        <DockItem
          key={destination.to}
          destination={destination}
          pointer={pointer}
          placement={placement}
          onScreen={onScreen}
        />
      ))}
    </ul>
  );
}

function DockItem({
  destination: { to, label, Icon },
  pointer,
  placement,
  onScreen,
}: {
  destination: NavDestination;
  pointer: MotionValue<number>;
  placement: Placement;
  onScreen: (event: ReactMouseEvent, active: boolean) => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const active = useMatch({ path: to, end: true }) !== null;
  const distance = useTransform(pointer, (at) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || !Number.isFinite(at)) return DOCK.reach;
    return at - (box.left + box.width / 2);
  });
  const target = useTransform<number, number>(
    distance,
    [-DOCK.reach, 0, DOCK.reach],
    [DOCK.rest, DOCK.peak, DOCK.rest],
  );
  const size = useSpring(target, DOCK.spring);
  const scale = useTransform(size, (value) => value / DOCK.rest);
  // Lifts towards the middle of the window: down from an island near the top, up from one below.
  const lift = useTransform(size, [DOCK.rest, DOCK.peak], [0, placement === 'below' ? 7 : -7]);

  return (
    <motion.li ref={ref} className="dock__slot" style={{ width: size }}>
      <NavLink
        to={to}
        draggable={false}
        aria-label={label}
        className={({ isActive }) => `dock__item${isActive ? ' dock__item--active' : ''}`}
        onClick={(event) => onScreen(event, active)}
      >
        <motion.span className="dock__tile" style={{ scale, y: lift }}>
          <Icon aria-hidden="true" strokeWidth={1.75} />
        </motion.span>
        <span className="dock__label" aria-hidden="true">
          {label}
        </span>
        {active ? <span className="dock__dot" aria-hidden="true" /> : null}
      </NavLink>
    </motion.li>
  );
}
