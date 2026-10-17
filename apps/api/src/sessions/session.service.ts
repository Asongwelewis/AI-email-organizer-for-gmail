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
    const session = await sessionRepository.findByTokenHash(sha256(rawToken));
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

  private touch(record: SessionRecord, now: Date): void {
    void sessionRepository.touch(record.id, new Date(now.getTime() - TOUCH_INTERVAL_MS), now);
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
        return { session: context({ ...record, expires_at: target }), renewedToken: rawToken };
      }
    }
    this.touch(record, now);
    return { session: context(record), renewedToken: null };
  }

  async revokeCurrent(request: Request): Promise<AuthenticatedSession | null> {
    const rawToken = this.getRawToken(request);
    if (!rawToken) return null;
    const session = await sessionRepository.findByTokenHash(sha256(rawToken));
    if (!session) return null;
    await sessionRepository.revoke(session.id, 'USER_LOGOUT');
    return context(session);
  }

  revokeAll(userId: string) {
    return sessionRepository.revokeAllForUser(userId, 'USER_LOGOUT_ALL');
  }

  async rotate(request: Request) {
    const { record } = await this.validRecord(request);
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
