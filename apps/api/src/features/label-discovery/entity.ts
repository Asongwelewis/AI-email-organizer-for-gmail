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
};

/**
 * Mail providers whose addresses are people, not organisations.
 *
 * Mail from someone@gmail.com is from a person, and used to be filed under a "Google" folder beside
 * Google's own security alerts — the same for Outlook and Microsoft, iCloud and Apple. A person is
 * not a brand, so all of it is the one `personal` entity: a folder of mail from people. The same
 * list keeps a person's address from ever becoming a reference routing rule.
 */
export const PERSONAL_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.fr',
  'ymail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.fr',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.net',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
]);

export const PERSONAL_ENTITY = 'personal';

/**
 * Domains that host other people's brands rather than being one.
 *
 * Every Substack publication sends from `<publication>@substack.com`, so the registrable domain is
 * the platform and the brand is the local part. Deriving from the domain collapses ByteByteGo,
 * System Design Nuggets and Lenny's Newsletter into a single `substack` folder holding a scattered
 * pile of unrelated newsletters — which is exactly the clutter the entity facet exists to remove,
 * arrived at from the other direction.
 *
 * The local part rather than the display name, deliberately. A display name is chosen by the
 * sender, changes between sends, and can be anything; the address is a fact about the envelope,
 * which is the whole basis on which this facet is derived in code instead of being asked of a
 * model.
 */
const PLATFORM_SENDER_DOMAINS = new Set([
  'substack.com',
  'beehiiv.com',
  'ghost.io',
  'medium.com',
  'googlegroups.com',
  'buttondown.email',
  'convertkit-mail.com',
  'kit.com',
]);

/**
 * Local parts that name the platform's own mail rather than a publication on it.
 *
 * `no-reply@substack.com` is Substack writing to you; `bytebytego@substack.com` is ByteByteGo. The
 * first should stay under the platform, and a folder called "No reply" would be nonsense.
 */
const GENERIC_LOCAL_PARTS = new Set([
  'no-reply',
  'noreply',
  'donotreply',
  'do-not-reply',
  'hello',
  'hi',
  'info',
  'support',
  'help',
  'team',
  'mail',
  'email',
  'newsletter',
  'news',
  'notifications',
  'notification',
  'updates',
  'post',
  'admin',
  'contact',
  'billing',
]);

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
  const identity = emailIdentity(senderEmail);
  const registrable = identity.registrableDomain;
  if (!registrable) return null;

  // A person writes from the provider's own domain. news.proton.me and notify.proton.me are
  // Proton the company, and an automated address on the bare domain is the provider too.
  if (
    PERSONAL_MAIL_DOMAINS.has(registrable) &&
    identity.senderDomain === registrable &&
    !identity.automated
  ) {
    return PERSONAL_ENTITY;
  }

  if (PLATFORM_SENDER_DOMAINS.has(registrable)) {
    const publication = publicationFrom(senderEmail);
    if (publication) return publication;
  }

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
 * The publication behind a platform address, or null when the address is the platform's own.
 *
 * Plus-addressing is stripped first: `nextplayso+should-you-join@substack.com` is one more send
 * from `nextplayso`, and treating the tag as part of the name would file every campaign into a
 * folder of its own.
 */
function publicationFrom(senderEmail: string | null): string | null {
  const local = (senderEmail ?? '').split('@')[0]?.toLowerCase().split('+')[0]?.trim();
  if (!local) return null;
  const slug = local.replace(SLUG_UNSAFE, '-').replace(/^-+|-+$/g, '');
  // Too short to be a name, or the platform speaking for itself.
  if (slug.length < 3 || GENERIC_LOCAL_PARTS.has(slug)) return null;
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
/**
 * The domain to show each brand's logo for: the registrable domain its mail most often comes from.
 *
 * An entity is a slug — "netflix" — and a logo service wants a domain. Most brands send from one,
 * but a brand mailing from `netflix.com` and `mailer.netflix.net` should show the logo of the one
 * it mostly uses, and a publication on a platform keeps the platform's domain, whose logo is the
 * honest one to show.
 */
export function entityIconDomains(
  messages: Array<{ entity: string | null; senderEmail?: string | null }>,
): Map<string, string> {
  const tallies = new Map<string, Map<string, number>>();
  for (const message of messages) {
    if (!message.entity || !message.senderEmail) continue;
    const domain = emailIdentity(message.senderEmail).registrableDomain;
    if (!domain) continue;
    const tally = tallies.get(message.entity) ?? new Map<string, number>();
    tally.set(domain, (tally.get(domain) ?? 0) + 1);
    tallies.set(message.entity, tally);
  }
  const chosen = new Map<string, string>();
  for (const [entity, tally] of tallies) {
    const [best] = [...tally.entries()].sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    );
    if (best) chosen.set(entity, best[0]);
  }
  return chosen;
}

export function entityDisplayName(entity: string): string | null {
  return ENTITY_DISPLAY_NAMES[entity] ?? null;
}
