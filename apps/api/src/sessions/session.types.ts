import type { user_status } from '@prisma/client';

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  status: user_status;
  tutorialCompletedAt: string | null;
}

export interface AuthenticatedSession {
  id: string;
  user: AuthenticatedUser;
  /** ISO time the session stops being valid. Public: it is the cookie's own lifetime. */
  expiresAt: string;
}

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthenticatedSession;
    }
  }
}

export {};
