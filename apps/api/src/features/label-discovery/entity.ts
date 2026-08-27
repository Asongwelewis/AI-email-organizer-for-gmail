import { emailIdentity } from './label-normalization.js';

/**
 * The `entity` facet: which brand a message is from.
 *
 * Derived from the sender domain and never asked of a model. A brand is a fact about the envelope,
 * not a judgement — spending input tokens to have a model read "netflix.com" and answer "netflix"
 * would be paying for something `tldts` already knows, and would let the model be wrong about it.
 */

/**
 * Domains whose registrable name is not the brand. Almost all of these are the separate domain a
 * large service sends bulk mail from, which otherwise files as its own entity: `redditmail` and
 * `reddit` are one brand with two mail domains, and folders for both is exactly the clutter facets
 * are meant to remove.
 *
 * Keyed by registrable domain so a subdomain never has to be listed: `mail.notifications.reddit.com`
 * and `reddit.com` both resolve through the same entry.
 */
const ENTITY_ALIASES: Record<string, string> = {
  'redditmail.com': 'reddit',
  'facebookmail.com': 'facebook',
  'googlemail.com': 'google',
  'gmail.com': 'google',
  'linkedin-ei.com': 'linkedin',
  'youtube.com': 'youtube',
  'awsapps.com': 'aws',
  'amazonses.com': 'amazon',
  'sendgrid.net': 'sendgrid',
  'mailchimpapp.net': 'mailchimp',
  'substackcdn.com': 'substack',
  'githubusercontent.com': 'github',
  'microsoftonline.com': 'microsoft',
  'office365.com': 'microsoft',
  'live.com': 'microsoft',
  'outlook.com': 'microsoft',
  'hotmail.com': 'microsoft',
  'icloud.com': 'apple',
  'me.com': 'apple',
  'yahoo.com': 'yahoo',
  'ymail.com': 'yahoo',
};

/**
 * Suffixes a brand bolts onto its own name for a mail domain. Stripped only when the remainder is
 * still a plausible brand name, so `mailchimp` does not become `chimp` and `dell` keeps its name.
 */
const MAIL_SUFFIXES = ['mail', 'email', 'mailer', 'notifications', 'notify', 'send'];

/**
 * Shortest remainder a suffix strip may leave. Five, not four: at four, `fastmail` becomes `fast`,
 * which is a different brand rather than a shorter spelling of the same one.
 */
const MIN_STRIPPED_LENGTH = 5;

/** Entity slugs are kebab-case like every other facet value. */
const SLUG_UNSAFE = /[^a-z0-9]+/g;

/**
 * The entity for a sender address, or null when the address carries no usable domain.
 *
 * Null is a real answer, not a failure: a message with no sender still has a domain and an intent,
 * and Phase 3 has to be able to pivot it without inventing a brand for it.
 */
export function entityFor(senderEmail: string | null): string | null {
  const registrable = emailIdentity(senderEmail).registrableDomain;
  if (!registrable) return null;

  const alias = ENTITY_ALIASES[registrable];
  if (alias) return alias;

  // The registrable domain already drops every subdomain, so what is left is the brand plus a
  // public suffix: "linkedin.com" -> "linkedin", "bbc.co.uk" -> "bbc".
  const head = registrable.split('.')[0];
  if (!head) return null;

  const slug = head.replace(SLUG_UNSAFE, '-').replace(/^-+|-+$/g, '');
  if (!slug) return null;

  for (const suffix of MAIL_SUFFIXES) {
    if (!slug.endsWith(suffix) || slug === suffix) continue;
    const stripped = slug.slice(0, -suffix.length).replace(/-+$/, '');
    if (stripped.length >= MIN_STRIPPED_LENGTH) return stripped;
  }
  return slug;
}

/**
 * Brands whose own capitalisation is not what capitalising the slug produces.
 *
 * `entityFor` lowercases a domain, so the folder name would otherwise read "Linkedin", "Github",
 * "Openai". These become real folders in someone's mailbox, and a folder named after a company
 * should be spelled the way the company spells it.
 */
const ENTITY_DISPLAY_NAMES: Record<string, string> = {
  aws: 'AWS',
  ea: 'EA',
  ebay: 'eBay',
  github: 'GitHub',
  gitlab: 'GitLab',
  ibm: 'IBM',
  linkedin: 'LinkedIn',
  mtn: 'MTN',
  openai: 'OpenAI',
  paypal: 'PayPal',
  postgresql: 'PostgreSQL',
  tiktok: 'TikTok',
  youtube: 'YouTube',
};

/** How an entity is spelled in a folder name, or null to fall back to the generic rule. */
export function entityDisplayName(entity: string): string | null {
  return ENTITY_DISPLAY_NAMES[entity] ?? null;
}
