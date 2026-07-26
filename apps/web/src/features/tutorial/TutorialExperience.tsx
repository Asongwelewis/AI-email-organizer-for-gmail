import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, Check, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useLocation, useNavigate } from 'react-router-dom';

import { TUTORIAL_PROGRESS_KEY, tutorialSteps } from './tutorial.scenario';

interface HighlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface CardPosition {
  top?: number;
  left: number | string;
  right?: number | string;
  bottom?: number | string;
  width?: number;
}

const padding = 10;

function progressKey(accountId: string): string {
  return `${TUTORIAL_PROGRESS_KEY}:${accountId}`;
}

function savedProgress(accountId: string): number | null {
  const value = window.sessionStorage.getItem(progressKey(accountId));
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed < tutorialSteps.length ? parsed : null;
}

export function TutorialExperience({
  accountId,
  eligible,
  onComplete,
}: {
  accountId: string;
  eligible: boolean;
  onComplete: (decision: 'COMPLETED' | 'SKIPPED') => Promise<void>;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  // A stale session entry must never auto-open the tour for an account that
  // has already completed or skipped onboarding.
  const saved = eligible ? savedProgress(accountId) : null;
  const [active, setActive] = useState(saved !== null);
  const [stepIndex, setStepIndex] = useState(saved ?? 0);
  const [highlight, setHighlight] = useState<HighlightRect | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const step = tutorialSteps[stepIndex]!;

  const start = useCallback(() => {
    setStepIndex(0);
    setActive(true);
    setSaveError(false);
    window.sessionStorage.setItem(progressKey(accountId), '0');
  }, [accountId]);

  const finish = useCallback(
    async (decision: 'COMPLETED' | 'SKIPPED') => {
      setSaving(true);
      setSaveError(false);
      try {
        await onComplete(decision);
        setActive(false);
        setHighlight(null);
        window.sessionStorage.removeItem(progressKey(accountId));
      } catch {
        setSaveError(true);
      } finally {
        setSaving(false);
      }
    },
    [accountId, onComplete],
  );

  useEffect(() => {
    if (active || !eligible || window.sessionStorage.getItem(progressKey(accountId)) !== null) {
      return;
    }
    const timer = window.setTimeout(start, 900);
    return () => window.clearTimeout(timer);
  }, [accountId, active, eligible, start]);

  useEffect(() => {
    const startListener = () => start();
    window.addEventListener('mailmind:start-tutorial', startListener);
    return () => window.removeEventListener('mailmind:start-tutorial', startListener);
  }, [start]);

  useEffect(() => {
    if (!active) return;
    window.sessionStorage.setItem(progressKey(accountId), String(stepIndex));
    if (location.pathname !== step.route) {
      navigate(step.route);
      return;
    }

    let attempts = 0;
    let timer = 0;
    let target: HTMLElement | null = null;
    const measure = () => {
      if (!target) return;
      const rect = target.getBoundingClientRect();
      setHighlight({
        top: Math.max(8, rect.top - padding),
        left: Math.max(8, rect.left - padding),
        width: Math.min(window.innerWidth - 16, rect.width + padding * 2),
        height: Math.min(window.innerHeight - 16, rect.height + padding * 2),
      });
    };
    const locate = () => {
      target = document.querySelector<HTMLElement>(step.target);
      if (!target && attempts < 20) {
        attempts += 1;
        timer = window.setTimeout(locate, 100);
        return;
      }
      if (!target) {
        setHighlight(null);
        return;
      }
      target.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      timer = window.setTimeout(measure, 180);
      window.addEventListener('resize', measure);
      window.addEventListener('scroll', measure, true);
    };
    locate();
    cardRef.current?.focus();
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [accountId, active, location.pathname, navigate, step.route, step.target, stepIndex]);

  const move = (nextIndex: number) => {
    setHighlight(null);
    setStepIndex(nextIndex);
  };

  const handleKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') void finish('SKIPPED');
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      stepIndex === tutorialSteps.length - 1 ? void finish('COMPLETED') : move(stepIndex + 1);
    }
    if (event.key === 'ArrowLeft' && stepIndex > 0) {
      event.preventDefault();
      move(stepIndex - 1);
    }
    if (event.key === 'Tab') {
      const focusable = cardRef.current?.querySelectorAll<HTMLElement>('button');
      if (!focusable?.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  if (!active) return null;

  const cardStyle = cardPosition(highlight);

  return createPortal(
    <AnimatePresence>
      <div className="tutorial-layer" role="presentation">
        <div className="tutorial-scrim" />
        {highlight && (
          <motion.div
            className="tutorial-highlight"
            aria-hidden="true"
            animate={{
              top: highlight.top,
              left: highlight.left,
              width: highlight.width,
              height: highlight.height,
            }}
            transition={{ type: 'spring', stiffness: 320, damping: 34 }}
          />
        )}
        <motion.div
          ref={cardRef}
          className="tutorial-card"
          style={cardStyle}
          role="dialog"
          aria-modal="true"
          aria-labelledby="tutorial-title"
          aria-describedby="tutorial-description"
          tabIndex={-1}
          key={step.id}
          initial={{ opacity: 0, y: 14, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.25 }}
          onKeyDown={handleKeys}
        >
          <div className="tutorial-card__topline">
            <span>{step.eyebrow}</span>
            <button
              type="button"
              disabled={saving}
              onClick={() => void finish('SKIPPED')}
              aria-label="Skip tutorial"
            >
              <span>Skip tutorial</span>
              <X aria-hidden="true" />
            </button>
          </div>
          <div className="tutorial-card__number" aria-hidden="true">
            {String(stepIndex + 1).padStart(2, '0')}
          </div>
          <h2 id="tutorial-title">{step.title}</h2>
          <p id="tutorial-description">{step.description}</p>
          {step.note && <small>{step.note}</small>}
          {saveError && (
            <p className="tutorial-card__error" role="alert">
              The tutorial preference could not be saved. Please try again.
            </p>
          )}
          <div
            className="tutorial-progress"
            role="progressbar"
            aria-label="Tutorial progress"
            aria-valuemin={1}
            aria-valuemax={tutorialSteps.length}
            aria-valuenow={stepIndex + 1}
          >
            <span style={{ width: `${((stepIndex + 1) / tutorialSteps.length) * 100}%` }} />
          </div>
          <div className="tutorial-card__actions">
            <button
              className="tutorial-back"
              type="button"
              disabled={stepIndex === 0 || saving}
              onClick={() => move(stepIndex - 1)}
            >
              <ArrowLeft aria-hidden="true" /> Back
            </button>
            <span>
              {stepIndex + 1} / {tutorialSteps.length}
            </span>
            <button
              className="tutorial-next"
              type="button"
              disabled={saving}
              onClick={() =>
                stepIndex === tutorialSteps.length - 1
                  ? void finish('COMPLETED')
                  : move(stepIndex + 1)
              }
            >
              {saving ? (
                'Saving…'
              ) : stepIndex === tutorialSteps.length - 1 ? (
                <>
                  Finish <Check aria-hidden="true" />
                </>
              ) : (
                <>
                  Next <ArrowRight aria-hidden="true" />
                </>
              )}
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>,
    document.body,
  );
}

function cardPosition(highlight: HighlightRect | null): CardPosition {
  if (window.innerWidth < 760) {
    return {
      left: '1rem',
      right: '1rem',
      bottom: '1rem',
    };
  }
  const width = Math.min(420, window.innerWidth - 32);
  if (!highlight) {
    return {
      left: Math.max(16, (window.innerWidth - width) / 2),
      top: Math.max(16, (window.innerHeight - 500) / 2),
      width,
    };
  }
  const gap = 24;
  const rightSpace = window.innerWidth - (highlight.left + highlight.width);
  const left =
    rightSpace >= width + gap
      ? highlight.left + highlight.width + gap
      : Math.max(16, highlight.left - width - gap);
  const top = Math.min(Math.max(16, highlight.top), Math.max(16, window.innerHeight - 520));
  return { left, top, width };
}
