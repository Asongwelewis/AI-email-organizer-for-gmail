import { useCallback, useEffect, useRef, useState } from 'react';

import { placeConnectCard } from '@web/components/app/islandFrame';
import { islandApp } from '@web/lib/islandApp';
import { getSafeErrorMessage } from '@web/services/errorMessages';
import { api, type DesktopPairing } from '@web/services/http';

const CARD = { width: 400, height: 290 } as const;
const POLL_MS = 3_000;
const CONNECT_PAGE = 'https://www.mailmindai.tech/connect-island';

type Step =
  | { kind: 'ready' }
  | { kind: 'starting' }
  | { kind: 'waiting'; pairing: DesktopPairing }
  | { kind: 'expired' }
  | { kind: 'failed'; message: string };

/**
 * What the AMO Island desktop program shows until it is connected to an account.
 *
 * Google refuses sign-in inside a desktop program, so the island never signs in. It asks for a
 * code, opens AMO in the person's own browser — where they are signed in already — and waits while
 * they type the code there. The code is typed rather than carried in a link on purpose: see
 * `desktop-pairing.service.ts`. Once it is typed, the next poll brings a session, and the island
 * reloads into itself.
 */
export function IslandConnect() {
  const [step, setStep] = useState<Step>({ kind: 'ready' });
  const press = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    document.title = 'AMO Island';
    placeConnectCard(CARD.width, CARD.height);
  }, []);

  const start = useCallback(async () => {
    setStep({ kind: 'starting' });
    try {
      const pairing = await api.startDesktopPairing();
      setStep({ kind: 'waiting', pairing });
      islandApp.openExternal(CONNECT_PAGE);
    } catch (error) {
      setStep({ kind: 'failed', message: getSafeErrorMessage(error) });
    }
  }, []);

  const waiting = step.kind === 'waiting' ? step.pairing : null;
  useEffect(() => {
    if (!waiting) return;
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      try {
        const status = await api.completeDesktopPairing(waiting.pairingId, waiting.pollSecret);
        if (stopped) return;
        if (status === 'connected') {
          // A fresh start, so everything reads the new session from the beginning.
          window.location.replace('/inbox');
          return;
        }
        if (status === 'expired') {
          setStep({ kind: 'expired' });
          return;
        }
      } catch {
        // A dropped connection or a waking server: ask again on the next beat.
      }
      timer = window.setTimeout(() => void poll(), POLL_MS);
    };
    let timer = window.setTimeout(() => void poll(), POLL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [waiting]);

  return (
    <main
      className="island-connect"
      onPointerDown={(event) => {
        // The card moves like the island: drag it from anywhere that is not a button.
        if (event.button !== 0 || (event.target as Element).closest('button')) return;
        press.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerMove={(event) => {
        const from = press.current;
        if (!from || (event.buttons & 1) === 0) return;
        if (Math.hypot(event.clientX - from.x, event.clientY - from.y) < 4) return;
        press.current = null;
        islandApp.startDragging();
      }}
      onPointerUp={() => {
        press.current = null;
      }}
    >
      <h1 className="island-connect__title">Connect AMO Island</h1>

      {step.kind === 'waiting' ? (
        <>
          <p className="island-connect__text">
            AMO has opened in your browser. Sign in there if it asks, then type this code:
          </p>
          <p className="island-connect__code" aria-label={`Code ${step.pairing.userCode}`}>
            {step.pairing.userCode}
          </p>
          <div className="island-connect__actions">
            <button
              type="button"
              className="button button--quiet"
              onClick={() => islandApp.openExternal(CONNECT_PAGE)}
            >
              Open AMO again
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="island-connect__text">
            {step.kind === 'expired'
              ? 'That code ran out before it was typed. Start again for a new one.'
              : 'The island shows your mail on the desktop. Connect it once to your AMO account, through your browser.'}
          </p>
          {step.kind === 'failed' ? (
            <p className="island-connect__error" role="alert">
              {step.message}
            </p>
          ) : null}
          <div className="island-connect__actions">
            <button
              type="button"
              className="button button--primary"
              disabled={step.kind === 'starting'}
              onClick={() => void start()}
            >
              {step.kind === 'starting' ? 'Starting…' : 'Connect'}
            </button>
          </div>
        </>
      )}
    </main>
  );
}
