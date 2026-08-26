/**
 * The identifying details of whoever operates this deployment.
 *
 * Deliberately in one file and deliberately placeholders. Google's OAuth verification checks that
 * the operator named in a privacy policy matches the one on the Cloud Console project, and a
 * plausible-looking invented entity or support address is worse than an obvious blank: it reads as
 * real and fails review. Fill these in before submitting for verification, and before the app is
 * reachable by anyone but you.
 *
 * `LEGAL_CONTACT` becomes a public mailto on the privacy, terms and support pages, so it should be
 * an address intended to be public rather than a personal one.
 */

export const LEGAL_ENTITY = '[OPERATOR NAME — fill in before public release]';

export const LEGAL_CONTACT = '[support@your-domain — fill in before public release]';

/** The date on the documents. Bump it when their substance changes, not when a typo is fixed. */
export const LEGAL_UPDATED = '27 August 2026';
