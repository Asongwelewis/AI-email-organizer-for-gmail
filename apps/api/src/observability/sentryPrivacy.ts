import type { Breadcrumb, Event } from '@sentry/node';

interface SentrySpan {
  data?: Record<string, unknown>;
  description?: string;
  op?: string;
}

const SENSITIVE_ROUTE =
  /\/(?:api\/)?(?:auth|integrations\/google|gmail|classification|label-discovery|automation)(?:\/|$)/i;
const SENSITIVE_FRAME =
  /[\\/](?:auth|database|repositories|integrations[\\/](?:gmail|google)|features[\\/](?:automation|classification|label-discovery))[\\/]/i;
const SENSITIVE_KEY =
  /authorization|cookie|token|secret|password|oauth|gmail|message|subject|snippet|body|email/i;
const SENSITIVE_PATH_PREFIX =
  /^(.*?\/(?:api\/)?(?:auth|gmail|classification|label-discovery|automation|integrations\/google))(?=\/|$)/i;
const SENSITIVE_PATH_IN_TEXT =
  /\/(?:api\/)?(?:auth|gmail|classification|label-discovery|automation|integrations\/google)(?:\/[^\s"'<>?]*)?/gi;
const SAFE_TAGS = new Set(['service', 'operation', 'phase', 'audit_action']);
const SAFE_SPAN_DATA = new Set([
  'http.method',
  'http.status_code',
  'http.response.status_code',
  'http.url',
  'url.full',
  'url.scheme',
]);
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_ASSIGNMENT =
  /\b(access_token|refresh_token|id_token|authorization|cookie|code|state|client_secret|password)=([^&\s]+)/gi;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) || ['code', 'state'].includes(key.toLowerCase());
}

export function sanitizeSentryUrl(value: string): string {
  try {
    const absolute = /^[a-z][a-z\d+.-]*:\/\//i.test(value);
    const url = new URL(value, 'https://mailmind.invalid');
    let pathname = url.pathname;
    const sensitivePrefix = pathname.match(SENSITIVE_PATH_PREFIX)?.[1];
    if (sensitivePrefix && pathname.length > sensitivePrefix.length) {
      pathname = `${sensitivePrefix}/[REDACTED_PATH]`;
    }
    return absolute ? `${url.protocol}//${url.host}${pathname}` : pathname;
  } catch {
    return value.split(/[?#]/, 1)[0] ?? '[REDACTED_URL]';
  }
}

export function redactSentryText(value: string): string {
  return value
    .replace(URL_PATTERN, (url) => sanitizeSentryUrl(url))
    .replace(SENSITIVE_PATH_IN_TEXT, (path) => sanitizeSentryUrl(path))
    .replace(EMAIL_PATTERN, '[REDACTED_EMAIL]')
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(SECRET_ASSIGNMENT, '$1=[REDACTED]');
}

function isSensitiveEvent(event: Event): boolean {
  if (event.request?.url && SENSITIVE_ROUTE.test(event.request.url)) return true;
  if (event.transaction && SENSITIVE_ROUTE.test(event.transaction)) return true;

  return Boolean(
    event.exception?.values?.some(
      (exception) =>
        Boolean(exception.type && /prisma|postgres|database/i.test(exception.type)) ||
        exception.stacktrace?.frames?.some(
          (frame) => frame.filename && SENSITIVE_FRAME.test(frame.filename),
        ),
    ),
  );
}

function sanitizeBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category?.startsWith('console') || breadcrumb.category?.startsWith('db')) {
    return null;
  }

  const next: Breadcrumb = {
    ...(breadcrumb.type ? { type: breadcrumb.type } : {}),
    ...(breadcrumb.category ? { category: breadcrumb.category } : {}),
    ...(breadcrumb.level ? { level: breadcrumb.level } : {}),
    ...(breadcrumb.timestamp ? { timestamp: breadcrumb.timestamp } : {}),
  };

  if (breadcrumb.data) {
    const safeData: Record<string, unknown> = {};
    for (const key of ['method', 'status_code', 'http.method', 'http.status_code']) {
      if (key in breadcrumb.data) safeData[key] = breadcrumb.data[key];
    }
    const url = breadcrumb.data['url'];
    if (typeof url === 'string' && !/googleapis\.com|oauth2\.googleapis\.com/i.test(url)) {
      safeData['url'] = sanitizeSentryUrl(url);
    }
    if (Object.keys(safeData).length) next.data = safeData;
  }

  return next;
}

export function scrubSentryEvent<T extends Event>(event: T): T {
  const sensitiveEvent = isSensitiveEvent(event);

  delete event.user;
  delete event.extra;

  if (event.request) {
    event.request = {
      ...(event.request.method ? { method: event.request.method } : {}),
      ...(event.request.url ? { url: sanitizeSentryUrl(event.request.url) } : {}),
    };
  }

  if (event.contexts) {
    const safeContexts = Object.fromEntries(
      Object.entries(event.contexts).filter(([key]) =>
        ['app', 'os', 'runtime', 'trace'].includes(key),
      ),
    );
    event.contexts = safeContexts;
  }

  if (event.tags) {
    event.tags = Object.fromEntries(
      Object.entries(event.tags)
        .filter(([key]) => SAFE_TAGS.has(key) && !isSensitiveKey(key))
        .map(([key, value]) => [key, typeof value === 'string' ? redactSentryText(value) : value]),
    );
  }

  if (event.transaction) event.transaction = redactSentryText(event.transaction);

  if (event.message) {
    event.message = sensitiveEvent
      ? 'Sensitive MailMind operation failed'
      : redactSentryText(event.message);
  }

  for (const exception of event.exception?.values ?? []) {
    if (exception.value) {
      exception.value = sensitiveEvent ? 'Sensitive MailMind operation failed' : 'MailMind failed';
    }
  }

  event.breadcrumbs = (event.breadcrumbs ?? [])
    .map(sanitizeBreadcrumb)
    .filter((breadcrumb): breadcrumb is Breadcrumb => breadcrumb !== null);

  return event;
}

export function scrubSentrySpan<T extends SentrySpan>(span: T): T {
  if (span.description) {
    span.description = /db|database|prisma|sql/i.test(span.op ?? '')
      ? 'database operation'
      : redactSentryText(span.description);
  }

  const safeData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(span.data ?? {})) {
    if (!SAFE_SPAN_DATA.has(key) || isSensitiveKey(key)) continue;
    if (typeof value === 'string') {
      safeData[key] = key.includes('url') ? sanitizeSentryUrl(value) : redactSentryText(value);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      safeData[key] = value;
    }
  }
  span.data = safeData;
  return span;
}

export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  return sanitizeBreadcrumb(breadcrumb);
}
