import type { AuthMeResponse } from '@web/types/auth';

/**
 * What the app remembers between launches, so it can open on something instead of a spinner.
 *
 * The API runs on a free plan that sleeps when nobody uses it, and waking it takes the better part
 * of a minute. Every launch used to sit on "Checking your session" for that whole time, then ask
 * for the folder settings, then — only then — for the folders. Opening on what was last seen and
 * replacing it as answers arrive turns that wait into a refresh you can already read through.
 *
 * What is kept is deliberately small, and never mail. The service worker is forbidden from caching
 * API responses because a shared device would show one account's mail to the next person, and
 * that rule still stands: this holds the signed-in profile and the folder tree — folder names and
 * counts, no subjects, no senders, no message ids. It is forgotten on logout, on any 401, and it is
 * never read back once the session it belongs to has expired, so a stranger opening the app after
 * the session ran out sees the sign-in screen and nothing else.
 */

const PREFIX = 'mailmind_snapshot:';
const SESSION_KEY = `${PREFIX}session`;

interface Stored<T> {
  /** Which request this answers — the folder tree for one ordering is not the tree for another. */
  variant: string;
  data: T;
}

function read<T>(key: string): T | undefined {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Full or blocked storage costs a faster launch, nothing more.
  }
}

/** The remembered session, if there is one and it has not expired. */
export function rememberedSession(now = Date.now()): AuthMeResponse | undefined {
  const session = read<AuthMeResponse>(SESSION_KEY);
  if (!session?.user || !session.sessionExpiresAt) return undefined;
  if (Date.parse(session.sessionExpiresAt) <= now) {
    forgetSession();
    return undefined;
  }
  return session;
}

export function rememberSession(session: AuthMeResponse): void {
  // A response without an expiry cannot be trusted later, so it is not remembered at all.
  if (session.sessionExpiresAt) write(SESSION_KEY, session);
}

/** Drops everything this module ever stored. */
export function forgetSession(): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) window.localStorage.removeItem(key);
  } catch {
    // Nothing was readable, so nothing was going to be shown either.
  }
}

/** The last answer for `name`, only while the session it was fetched under is still valid. */
export function recall<T>(name: string, variant: string): T | undefined {
  if (!rememberedSession()) return undefined;
  const stored = read<Stored<T>>(`${PREFIX}${name}`);
  return stored && stored.variant === variant ? stored.data : undefined;
}

/** Keeps one answer per name. The newest replaces the last, so storage cannot grow. */
export function remember<T>(name: string, variant: string, data: T): T {
  write(`${PREFIX}${name}`, { variant, data } satisfies Stored<T>);
  return data;
}

/**
 * A query that opens on its last answer and refetches behind it.
 *
 * `placeholderData` rather than `initialData`: placeholder data is never treated as fresh, so the
 * real request always goes out, and it never lands in the cache under the real key.
 */
export function rememberedQuery<T>(name: string, variant: string, fetch: () => Promise<T>) {
  return {
    queryFn: async () => remember(name, variant, await fetch()),
    placeholderData: () => recall<T>(name, variant),
  };
}
