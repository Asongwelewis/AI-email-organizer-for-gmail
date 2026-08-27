process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] = 'silent';
// Pin the trusted-origin allowlist so CORS and CSRF tests do not depend on a developer's
// local apps/api/.env. Set before src/config/env.ts loads dotenv, which never overrides
// values already present in process.env.
process.env['WEB_APP_URL'] = 'http://localhost:5173';
