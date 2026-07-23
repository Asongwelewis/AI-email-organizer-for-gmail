export type ErrorCode =
  | 'AUTHENTICATION_REQUIRED'
  | 'AUTH_SESSION_EXPIRED'
  | 'AUTH_SESSION_REVOKED'
  | 'AUTH_USER_SUSPENDED'
  | 'AUTH_USER_DELETED'
  | 'AUTH_OAUTH_STATE_INVALID'
  | 'AUTH_OAUTH_STATE_EXPIRED'
  | 'AUTH_OAUTH_STATE_USED'
  | 'AUTH_GOOGLE_CALLBACK_FAILED'
  | 'AUTH_GOOGLE_IDENTITY_INVALID'
  | 'GMAIL_PERMISSION_DENIED'
  | 'GMAIL_PERMISSION_INCOMPLETE'
  | 'GMAIL_CONNECTION_FAILED'
  | 'GMAIL_REAUTH_REQUIRED'
  | 'GMAIL_ALREADY_DISCONNECTED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'CORS_ORIGIN_DENIED'
  | 'CSRF_ORIGIN_INVALID'
  | 'DATABASE_UNAVAILABLE'
  | 'INTERNAL_SERVER_ERROR'
  | 'NOT_FOUND';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly statusCode = 500,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const authenticationRequired = () =>
  new AppError('AUTHENTICATION_REQUIRED', 'You need to sign in to continue.', 401);
