/**
 * The identifying details of whoever operates this deployment.
 *
 * Kept in one file because Google's OAuth verification checks that the operator named in the
 * privacy policy and terms matches the one on the Cloud Console consent screen, and the support
 * address there too. Change them together: here, then the consent screen's user support and
 * developer contact emails.
 *
 * `LEGAL_CONTACT` is a public mailto on the privacy, terms, support and data-deletion pages.
 */

export const LEGAL_ENTITY = 'Asongwe Lewis Fon';

export const LEGAL_CONTACT = 'fonasongwelewis@gmail.com';

/** The date on the documents. Bump it when their substance changes, not when a typo is fixed. */
export const LEGAL_UPDATED = '24 October 2026';
