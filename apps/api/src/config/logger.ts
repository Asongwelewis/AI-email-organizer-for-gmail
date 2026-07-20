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
