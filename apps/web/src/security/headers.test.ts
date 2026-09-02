/// <reference types="node" />
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import indexHtmlSource from '../../index.html?raw';

/**
 * The perimeter around the document.
 *
 * Helmet covers API responses, and an API's headers do not protect the page: the browser applies
 * a document's own policy, and `vercel.json` set only a history rewrite. Everything asserted here
 * lives in that file, so it is the only place these can be verified before a deploy.
 *
 * The hash is the part worth a test. The pre-paint theme script has to run inline — that is the
 * whole point of it, it stamps the theme before the first paint — so the policy names its SHA-256
 * rather than opening `script-src` to every inline script on the page. A hash pinned in JSON and
 * an inline script in HTML have no way to stay in step on their own: edit the script and the page
 * silently stops running it, which is a white flash on every load and nothing in any log. This
 * test is that link.
 */

// The bytes a browser hashes are the bytes it is served. Git checks out LF on Vercel's Linux
// builders whatever a developer's working copy holds, so the comparison is normalised.
const indexHtml = indexHtmlSource.replace(/\r\n/g, '\n');
/**
 * Walks up for `vercel.json`, because the working directory differs between `npm test` in the
 * workspace and a `vitest --root` invocation, and a test that reads the wrong file — or no file —
 * would pass by asserting nothing.
 */
function repositoryRoot(): string {
  let directory = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(directory, 'vercel.json'))) return directory;
    directory = dirname(directory);
  }
  throw new Error('vercel.json not found above the working directory');
}

const vercelConfig = JSON.parse(readFileSync(join(repositoryRoot(), 'vercel.json'), 'utf8')) as {
  headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
};

function headerValue(source: string, key: string): string {
  const rule = vercelConfig.headers.find((candidate) => candidate.source === source);
  if (!rule) throw new Error(`vercel.json has no header rule for ${source}`);
  const header = rule.headers.find((candidate) => candidate.key === key);
  if (!header) throw new Error(`vercel.json sets no ${key} on ${source}`);
  return header.value;
}

const csp = headerValue('/(.*)', 'Content-Security-Policy');

/** The one inline script in the document: the pre-paint theme stamp. */
function inlineScripts(): string[] {
  return [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
}

describe('the document security policy', () => {
  it('names the exact hash of the pre-paint theme script', () => {
    const scripts = inlineScripts();
    // More than one would mean a hash was added for a script nobody checked, or dropped for one
    // that now runs unpolicied. Either way the assertion below stops describing the page.
    expect(scripts).toHaveLength(1);

    const hash = createHash('sha256').update(scripts[0]!, 'utf8').digest('base64');
    expect(csp).toContain(`'sha256-${hash}'`);
  });

  /**
   * `unsafe-inline` on scripts is the thing a CSP mostly exists to prevent. `style-src` is a
   * different question — React writes element styles as attributes, and the folder tiles carry a
   * per-folder hue that way — so inline styles are allowed and inline scripts are not.
   */
  it('never opens script-src to arbitrary inline script', () => {
    const scriptSrc = csp.split(';').find((directive) => directive.trim().startsWith('script-src'));

    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  });

  // Everything the page actually loads has to be reachable, or the policy is a broken deploy.
  it('allows exactly the third parties the page uses, and nothing wider', () => {
    expect(csp).toContain('https://fonts.googleapis.com');
    expect(csp).toContain('https://fonts.gstatic.com');
    // The API and Sentry ingest are the only cross-origin requests the app makes.
    expect(csp).toContain('https://api.mailmindai.tech');
    expect(csp).toContain('sentry.io');
    expect(csp).not.toContain('*.vercel.app');
    expect(csp).not.toMatch(/(script|connect|default)-src[^;]*\*(?![.\w])/);
  });

  // Clickjacking is the one attack a SPA's own code cannot defend against.
  it('refuses to be framed', () => {
    expect(csp).toContain("frame-ancestors 'none'");
    expect(headerValue('/(.*)', 'X-Frame-Options')).toBe('DENY');
  });

  it('sets the rest of the perimeter', () => {
    expect(headerValue('/(.*)', 'Strict-Transport-Security')).toContain('max-age=63072000');
    expect(headerValue('/(.*)', 'X-Content-Type-Options')).toBe('nosniff');
    expect(headerValue('/(.*)', 'Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headerValue('/(.*)', 'Permissions-Policy')).toContain('geolocation=()');
    expect(headerValue('/(.*)', 'Cross-Origin-Resource-Policy')).toBe('same-site');
    expect(headerValue('/(.*)', 'Origin-Agent-Cluster')).toBe('?1');
    expect(headerValue('/(.*)', 'X-DNS-Prefetch-Control')).toBe('off');
    expect(headerValue('/(.*)', 'X-Permitted-Cross-Domain-Policies')).toBe('none');
  });

  /**
   * The service worker decides what an installed copy runs. A cached one that outlives a security
   * fix is that fix not shipping, so it revalidates while the hashed assets it points at do not.
   */
  it('never lets the service worker be cached', () => {
    expect(headerValue('/sw.js', 'Cache-Control')).toContain('must-revalidate');
    expect(headerValue('/assets/(.*)', 'Cache-Control')).toContain('immutable');
  });
});
