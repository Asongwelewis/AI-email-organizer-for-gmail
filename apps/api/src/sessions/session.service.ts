import type { Request } from 'express';

import { env } from '@api/config/env.js';
import { AppError, authenticationRequired } from '@api/errors/AppError.js';
import { sessionRepository } from '@api/repositories/session.repository.js';
import { userRepository, type GoogleIdentityInput } from '@api/repositories/user.repository.js';
import { hmacSha256, sha256 } from '@api/security/hashing.service.js';
import { generateSecureToken } from '@api/security/random.service.js';
import { SESSION_COOKIE_NAME } from './session.cookies.js';
import type { AuthenticatedSession } from './session.types.js';

const TOUCH_INTERVAL_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far behind its target an expiry may fall before it is pushed forward. Once a day, so an
 * active session costs one extra write a day rather than one per request.
 */
const RENEW_INTERVAL_MS = DAY_MS;

type SessionRecord = NonNullable<Awaited<ReturnType<typeof sessionRepository.findByTokenHash>>>;

/**
 * How long a session row read from the database answers for itself. Every authenticated request
 * used to read its session row first: one round trip of 100-150ms from Render to Supabase in front
 * of every screen, and with several hundred people, most of the database's work was asking the
 * same question again. The PWA polls every two seconds while something runs, so thirty seconds
 * removes nearly all of it.
 *
 * The cost is bounded and one-sided. Logging out, rotating, or revoking on THIS instance drops the
 * entry at once; on another instance, a revoked session stays usable for at most this long.
 * Expiry is checked against the clock on every request, cached or not.
 */
const SESSION_CACHE_TTL_MS = 30_000;
const SESSION_CACHE_MAX_ENTRIES = 10_000;

interface CachedSession {
  record: SessionRecord;
  cachedAt: number;
  /** When this process last recorded use, so a cached session is not touched on every request. */
  touchedAt: number;
}

function usable(record: SessionRecord, now = new Date()): boolean {
  return (
    !record.revoked_at &&
    record.expires_at > now &&
    record.users.status !== 'SUSPENDED' &&
    record.users.status !== 'DELETED'
  );
}

/** Keyed by token hash, never by token: the raw cookie does not live anywhere in memory here. */
const sessionCache = new Map<string, CachedSession>();

function cacheSession(tokenHash: string, record: SessionRecord, touchedAt = 0): void {
  if (sessionCache.size >= SESSION_CACHE_MAX_ENTRIES) {
    // Insertion order is age order in a Map, so the first key is the stalest entry.
    const oldest = sessionCache.keys().next().value;
    if (oldest !== undefined) sessionCache.delete(oldest);
  }
  sessionCache.delete(tokenHash);
  sessionCache.set(tokenHash, { record, cachedAt: Date.now(), touchedAt });
}

/** Test seam, and what logout uses to forget every cached session of one user. */
export function forgetCachedSessions(predicate: (record: SessionRecord) => boolean = () => true) {
  for (const [key, entry] of sessionCache) if (predicate(entry.record)) sessionCache.delete(key);
}

/**
 * Where a session's expiry belongs right now: the idle window from now, but never past the hard
 * ceiling counted from sign-in. Sliding without the ceiling would let a stolen cookie that keeps
 * being used live forever.
 */
export function slidingExpiry(createdAt: Date, now = new Date()): Date {
  const idle = now.getTime() + env.REFRESH_SESSION_TTL_DAYS * DAY_MS;
  const ceiling = createdAt.getTime() + env.SESSION_MAX_LIFETIME_DAYS * DAY_MS;
  return new Date(Math.min(idle, ceiling));
}

function expiration(): Date {
  return slidingExpiry(new Date());
}

function context(session: SessionRecord | null): AuthenticatedSession {
  if (!session) throw authenticationRequired();
  return {
    id: session.id,
    expiresAt: session.expires_at.toISOString(),
    user: {
      id: session.users.id,
      email: session.users.email,
      displayName: session.users.display_name,
      avatarUrl: session.users.avatar_url,
      status: session.users.status,
      tutorialCompletedAt: session.users.tutorial_completed_at?.toISOString() ?? null,
    },
  };
}

export class SessionService {
  async create(userId: string, request: Request) {
    const rawToken = generateSecureToken();
    const session = await sessionRepository.create({
      user_id: userId,
      session_token_hash: sha256(rawToken),
      user_agent: request.get('user-agent')?.slice(0, 500) ?? null,
      ip_hash: request.ip ? hmacSha256(request.ip, env.SESSION_SECRET) : null,
      expires_at: expiration(),
    });
    return { rawToken, session: context(session) };
  }

  async createForGoogleIdentity(identity: GoogleIdentityInput, request: Request) {
    const rawToken = generateSecureToken();
    const result = await userRepository.upsertGoogleIdentityAndCreateSession(identity, {
      session_token_hash: sha256(rawToken),
      user_agent: request.get('user-agent')?.slice(0, 500) ?? null,
      ip_hash: request.ip ? hmacSha256(request.ip, env.SESSION_SECRET) : null,
      expires_at: expiration(),
    });
    return {
      rawToken,
      session: {
        id: result.session.id,
        user: {
          id: result.user.id,
          email: result.user.email,
          displayName: result.user.display_name,
          avatarUrl: result.user.avatar_url,
          status: result.user.status,
          tutorialCompletedAt: result.user.tutorial_completed_at?.toISOString() ?? null,
        },
        expiresAt: result.session.expires_at.toISOString(),
      } satisfies AuthenticatedSession,
    };
  }

  getRawToken(request: Request): string | undefined {
    const cookies = request.cookies as Record<string, unknown> | undefined;
    const token = cookies?.[SESSION_COOKIE_NAME];
    return typeof token === 'string' && token.length > 0 ? token : undefined;
  }

  /** The live session record behind this request's cookie, or the reason there is none. */
  private async validRecord(
    request: Request,
  ): Promise<{ rawToken: string; record: SessionRecord }> {
    const rawToken = this.getRawToken(request);
    if (!rawToken) throw authenticationRequired();
    const tokenHash = sha256(rawToken);
    const cached = sessionCache.get(tokenHash);
    // Only a session that is still good is answered from memory. Anything else is read again:
    // a copy that looks expired may have been slid forward by another instance since.
    let session: SessionRecord | null =
      cached && Date.now() - cached.cachedAt < SESSION_CACHE_TTL_MS && usable(cached.record)
        ? cached.record
        : null;
    if (!session) {
      session = await sessionRepository.findByTokenHash(tokenHash);
      if (session && usable(session)) cacheSession(tokenHash, session, cached?.touchedAt ?? 0);
      else sessionCache.delete(tokenHash);
    }
    if (!session) throw authenticationRequired();
    if (session.revoked_at) {
      throw new AppError('AUTH_SESSION_REVOKED', 'Your session is no longer active.', 401);
    }
    if (session.expires_at <= new Date()) {
      throw new AppError('AUTH_SESSION_EXPIRED', 'Your session has expired.', 401);
    }
    if (session.users.status === 'SUSPENDED') {
      throw new AppError('AUTH_USER_SUSPENDED', 'This account is suspended.', 403);
    }
    if (session.users.status === 'DELETED') {
      throw new AppError('AUTH_USER_DELETED', 'This account is unavailable.', 403);
    }
    return { rawToken, record: session };
  }

  /**
   * Records use at most once per TOUCH_INTERVAL_MS. The write was already conditional, but the
   * condition was asked of the database, so it still cost a round trip on every request.
   */
  private touch(record: SessionRecord, now: Date): void {
    const tokenHash = record.session_token_hash;
    const cached = sessionCache.get(tokenHash);
    if (cached && now.getTime() - cached.touchedAt < TOUCH_INTERVAL_MS) return;
    if (cached) cached.touchedAt = now.getTime();
    // Recording use is never worth failing a request over.
    void Promise.resolve(
      sessionRepository.touch(record.id, new Date(now.getTime() - TOUCH_INTERVAL_MS), now),
    ).catch(() => undefined);
  }

  /**
   * Checks the session without extending it. For callers that cannot re-issue the cookie in the
   * same response — extending the row there would leave the browser's copy expiring first.
   */
  async authenticate(request: Request): Promise<AuthenticatedSession> {
    const { record } = await this.validRecord(request);
    this.touch(record, new Date());
    return context(record);
  }

  /**
   * Checks the session and slides its expiry forward, at most once a day.
   *
   * It used to be fixed at sign-in: `touch` recorded use and nothing ever moved `expires_at`, so
   * someone who opened the app every day was still logged out on day fourteen. `renewedToken` is
   * set when the row was extended, and the caller then re-issues the cookie with the same token
   * and the new lifetime — no rotation is needed to change how long a cookie lives.
   */
  async authenticateAndRenew(
    request: Request,
  ): Promise<{ session: AuthenticatedSession; renewedToken: string | null }> {
    const { rawToken, record } = await this.validRecord(request);
    const now = new Date();
    const target = slidingExpiry(record.created_at, now);
    if (target.getTime() - record.expires_at.getTime() >= RENEW_INTERVAL_MS) {
      const extended = await sessionRepository.extend(record.id, target, now);
      if (extended.count === 1) {
        const renewed = { ...record, expires_at: target, last_used_at: now };
        cacheSession(record.session_token_hash, renewed, now.getTime());
        return { session: context(renewed), renewedToken: rawToken };
      }
      // Someone else revoked or expired it in between: forget the copy and let the next request
      // read the truth.
      sessionCache.delete(record.session_token_hash);
    }
    this.touch(record, now);
    return { session: context(record), renewedToken: null };
  }

  async revokeCurrent(request: Request): Promise<AuthenticatedSession | null> {
    const rawToken = this.getRawToken(request);
    if (!rawToken) return null;
    const tokenHash = sha256(rawToken);
    sessionCache.delete(tokenHash);
    const session = await sessionRepository.findByTokenHash(tokenHash);
    if (!session) return null;
    await sessionRepository.revoke(session.id, 'USER_LOGOUT');
    return context(session);
  }

  revokeAll(userId: string) {
    forgetCachedSessions((record) => record.user_id === userId);
    return sessionRepository.revokeAllForUser(userId, 'USER_LOGOUT_ALL');
  }

  async rotate(request: Request) {
    const { record } = await this.validRecord(request);
    sessionCache.delete(record.session_token_hash);
    const rawToken = generateSecureToken();
    // The replacement inherits the original sign-in time, so rotating cannot reset the ceiling.
    const replacement = await sessionRepository.rotate(
      record.id,
      sha256(rawToken),
      slidingExpiry(record.created_at),
      record.created_at,
    );
    if (!replacement)
      throw new AppError('AUTH_SESSION_REVOKED', 'Your session is no longer active.', 401);
    return { rawToken, session: context(replacement) };
  }
}

export const sessionService = new SessionService();
