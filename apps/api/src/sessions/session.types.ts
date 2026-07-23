import type { user_status } from '@prisma/client';

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  status: user_status;
}

export interface AuthenticatedSession {
  id: string;
  user: AuthenticatedUser;
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
