/**
 * Brand logos for folders, fetched once and served from here.
 *
 * Why not let the browser load them from a logo service directly: every <img> would tell that
 * service, along with the person's IP address, which companies send them mail. Fetched here, the
 * service sees one server asking about a domain and nothing about who.
 *
 * Why Google's favicon endpoint and never the sender's own site: a sender domain is whatever the
 * From line said, so fetching `https://<sender>/favicon.ico` from this server would let any email
 * point it at an address of the sender's choosing. Every request here goes to one fixed host.
 *
 * Unknown domains come back 404 from Google, and are answered 404 here, so the folder keeps its
 * folder icon rather than showing Google's grey globe. SVG is refused outright: served from the
 * API's own origin and opened directly, an SVG can run script.
 */

const ICON_SOURCE = 'https://www.google.com/s2/favicons';
const ICON_SIZE = 64;
const MAX_ICON_BYTES = 100 * 1024;
const ALLOWED_TYPES = new Set([
  'image/png',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MISSING_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHED = 1000;

/** A hostname, not a URL: letters, digits and hyphens in dot-separated labels, with a TLD. */
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface BrandIcon {
  contentType: string;
  body: Buffer;
}

interface CacheEntry {
  icon: BrandIcon | null;
  expiresAt: number;
}

export function isIconDomain(value: string): boolean {
  return DOMAIN.test(value);
}

export class BrandIconService {
  // Insertion-ordered, so the oldest entry is the first key: a Map is the whole LRU.
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<BrandIcon | null>>();

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  /** The logo for `domain`, or null when there is none worth showing. */
  async icon(domain: string, now = Date.now()): Promise<BrandIcon | null> {
    const key = domain.toLowerCase();
    if (!isIconDomain(key)) return null;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) {
      // Touch, so a logo on screen every day is never the one evicted.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.icon;
    }
    // A grid of folders asks for the same logo several times at once; fetch it once.
    const pending = this.inFlight.get(key) ?? this.fetchIcon(key);
    this.inFlight.set(key, pending);
    try {
      const icon = await pending;
      this.remember(key, icon, now);
      return icon;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private remember(key: string, icon: BrandIcon | null, now: number): void {
    this.cache.delete(key);
    this.cache.set(key, { icon, expiresAt: now + (icon ? FOUND_TTL_MS : MISSING_TTL_MS) });
    while (this.cache.size > MAX_CACHED) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async fetchIcon(domain: string): Promise<BrandIcon | null> {
    const url = `${ICON_SOURCE}?domain=${encodeURIComponent(domain)}&sz=${ICON_SIZE}`;
    let response: Response;
    try {
      response = await this.fetcher(url, { signal: AbortSignal.timeout(5_000) });
    } catch {
      // Unreachable is not the same as "no logo", so it is not cached as missing for a day.
      throw new Error('ICON_SOURCE_UNAVAILABLE');
    }
    if (!response.ok) return null;
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim();
    if (!ALLOWED_TYPES.has(contentType)) return null;
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length === 0 || body.length > MAX_ICON_BYTES) return null;
    return { contentType, body };
  }
}

export const brandIconService = new BrandIconService();
