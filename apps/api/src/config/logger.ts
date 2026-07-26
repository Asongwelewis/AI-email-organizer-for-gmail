import pino from 'pino';

import { env } from './env.js';

export const LOG_REDACTION_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers.set-cookie',
  'authorization',
  'cookie',
  'set-cookie',
  'code',
  'state',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'sessionToken',
  'session_token',
  'token',
  'password',
  'databaseUrl',
  'DATABASE_URL',
  'DIRECT_URL',
  'TOKEN_ENCRYPTION_KEY',
  '*.authorization',
  '*.cookie',
  '*.code',
  '*.state',
  '*.access_token',
  '*.refresh_token',
  '*.id_token',
  '*.client_secret',
  '*.sessionToken',
  '*.session_token',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: LOG_REDACTION_PATHS, censor: '[REDACTED]' },
  ...(env.NODE_ENV === 'production' || env.NODE_ENV === 'test'
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, singleLine: true, translateTime: 'SYS:standard' },
        },
      }),
});

export interface SafeErrorDetails {
  errorType: string;
  errorCode?: string;
  databaseCode?: string;
  databaseConstraint?: string;
}

const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const POSTGRES_CODE_PATTERN = /\bcode:\s*"([0-9A-Z]{5})"/;
const POSTGRES_CONSTRAINT_PATTERN = /\bconstraint\s+"([a-z0-9_]{1,128})"/i;

/**
 * Returns operationally useful error fields without serializing the error
 * message, stack, query, or cause. Database errors can include the entire
 * failing row, which may contain encrypted credential material.
 */
export function safeErrorDetails(error: unknown): SafeErrorDetails {
  const errorType =
    error instanceof Error ? (error.constructor.name || 'Error').slice(0, 100) : 'UnknownError';
  const candidateCode =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
  const message = error instanceof Error ? error.message : '';
  const databaseCode = message.match(POSTGRES_CODE_PATTERN)?.[1];
  const databaseConstraint = message.match(POSTGRES_CONSTRAINT_PATTERN)?.[1];

  return {
    errorType,
    ...(candidateCode && SAFE_ERROR_CODE.test(candidateCode) ? { errorCode: candidateCode } : {}),
    ...(databaseCode ? { databaseCode } : {}),
    ...(databaseConstraint ? { databaseConstraint } : {}),
  };
}
