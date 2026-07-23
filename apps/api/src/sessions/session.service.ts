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

function expiration(): Date {
  return new Date(Date.now() + env.REFRESH_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

function context(
  session: Awaited<ReturnType<typeof sessionRepository.findByTokenHash>>,
): AuthenticatedSession {
  if (!session) throw authenticationRequired();
  return {
    id: session.id,
    user: {
      id: session.users.id,
      email: session.users.email,
      displayName: session.users.display_name,
      avatarUrl: session.users.avatar_url,
      status: session.users.status,
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
        },
      } satisfies AuthenticatedSession,
    };
  }

  getRawToken(request: Request): string | undefined {
    const cookies = request.cookies as Record<string, unknown> | undefined;
    const token = cookies?.[SESSION_COOKIE_NAME];
    return typeof token === 'string' && token.length > 0 ? token : undefined;
  }

  async authenticate(request: Request): Promise<AuthenticatedSession> {
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
    const now = new Date();
    void sessionRepository.touch(session.id, new Date(now.getTime() - TOUCH_INTERVAL_MS), now);
    return context(session);
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
    const authenticated = await this.authenticate(request);
    const rawToken = generateSecureToken();
    const replacement = await sessionRepository.rotate(
      authenticated.id,
      sha256(rawToken),
      expiration(),
    );
    if (!replacement)
      throw new AppError('AUTH_SESSION_REVOKED', 'Your session is no longer active.', 401);
    return { rawToken, session: context(replacement) };
  }
}

export const sessionService = new SessionService();
