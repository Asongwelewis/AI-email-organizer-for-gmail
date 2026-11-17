import { useEffect, useState, type FormEvent } from 'react';
import { MonitorSmartphone } from 'lucide-react';

import { getSafeErrorMessage } from '@web/services/errorMessages';
import { api } from '@web/services/http';

/**
 * Where the code the AMO Island desktop program shows is typed, in the person's own browser.
 *
 * The code is typed, never arrives in the link: a link carrying it would let anyone who started a
 * pairing send it to somebody signed in here and be handed their session the moment they clicked.
 */
export function ConnectIslandPage() {
  const [code, setCode] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Connect AMO Island · AMO';
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setState('busy');
    setError(null);
    try {
      await api.approveDesktopPairing(code);
      setState('done');
    } catch (failure) {
      setError(getSafeErrorMessage(failure));
      setState('idle');
    }
  }

  return (
    <section className="screen">
      <header className="screen__head">
        <h1 className="screen__title">Connect AMO Island</h1>
      </header>

      {state === 'done' ? (
        <p className="screen__lede" role="status">
          Connected. The island on your desktop opens in a moment, and you can close this tab.
        </p>
      ) : (
        <>
          <p className="screen__lede">
            Type the code the island on your desktop is showing. Only enter a code from an island on
            your own computer: it gives that island access to your AMO account.
          </p>
          <form className="connect-island__form" onSubmit={(event) => void submit(event)}>
            <MonitorSmartphone aria-hidden="true" strokeWidth={1.5} />
            <input
              className="connect-island__input"
              aria-label="Code from the island"
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="BCDF-GHJK"
              maxLength={12}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <button
              type="submit"
              className="button button--primary"
              disabled={state === 'busy' || code.replace(/[^A-Za-z]/g, '').length !== 8}
            >
              {state === 'busy' ? 'Connecting…' : 'Connect'}
            </button>
          </form>
          {error ? (
            <p className="push-switch__error" role="alert">
              {error}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
