import { apiBaseUrl } from '@web/config/env';

/**
 * A brand folder's logo, fetched through our own API so the browser never tells a logo service
 * which companies send this person mail.
 */
export function brandIconUrl(domain: string | null | undefined): string | null {
  return domain ? `${apiBaseUrl}/facets/icons/${encodeURIComponent(domain)}` : null;
}
