import { emailIdentity } from './label-normalization.js';

/**
 * The last word on a message no rule recognised: generic keyword patterns, well-known brands, and
 * the category tabs Gmail already put the message in.
 *
 * Everything here is public knowledge — "verification code" means verification for everyone, and
 * linkedin.com is a careers site for everyone — so it is safe in a public repository, unlike the
 * reference rules, which are derived from one real mailbox and live only in the database.
 *
 * It answers in terms of the starter vocabulary's values, and the caller keeps only the values the
 * mailbox actually approved, so a mailbox that renamed or dropped a value is never handed it back.
 */

export interface HeuristicMessage {
  subject: string | null;
  senderEmail: string | null;
  snippet: string | null;
  labelIds: readonly string[] | null | undefined;
}

export interface HeuristicFacets {
  domain: string | null;
  intent: string | null;
}

/**
 * Most specific first: the first intent whose pattern matches wins. A "payment failed" email
 * usually also mentions an invoice, and a security alert often says "verify", so the narrow
 * meanings are checked before the broad ones.
 */
const INTENT_PATTERNS: Array<[string, RegExp]> = [
  [
    'payment-failed',
    /\b(payment (failed|declined|unsuccessful|was declined)|insufficient funds|card (was )?declined|update (your )?payment|account (is )?on hold|past due|could(n't| not) (process|charge)|risk of card)\b/,
  ],
  [
    'security-alert',
    /\b(security alert|new sign[- ]?in|sign[- ]?in attempt|unusual (activity|sign)|suspicious|password (was )?(changed|reset)|account (was )?recovered|logged in(to)?|login (from|alert)|2-step|two-factor)\b/,
  ],
  [
    'verification',
    /\b(verify|verification|confirm (your )?(email|account|address)|one[- ]time (code|password)|otp|security code|your code|activation (code|link)|magic link)\b/,
  ],
  [
    'application-received',
    /\b(application (was )?(sent|received|submitted)|thank(s| you) for (applying|your application)|we('ve| have) received your application)\b/,
  ],
  [
    'application-outcome',
    /\b(unfortunately|not (be )?moving forward|other candidates|interview (invitation|request|scheduled)|invite you to interview|offer letter|admission (decision|offer)|update on your application|your application (status|update))\b/,
  ],
  [
    'invoice-receipt',
    /\b(receipt|invoice|order (confirmation|confirmed|#)|your order|payment (received|confirmation|successful)|billing statement|purchase confirmation|subscription (renewed|confirmed))\b/,
  ],
  [
    'job-match',
    /(\b(is hiring|are hiring|jobs? (for you|alert|match|recommendation)|new jobs?|\d+% match|match(es)? your (profile|skills)|recommended jobs?|apply (now|to)|job opening|open (role|position)|internships?|intern|(full|part)[- ]time|remote role|job search|posted a role)\b|up to \$\d+k?\/(year|hour)|[“"][^”"]{3,60}[”"]:)/,
  ],
  [
    'welcome',
    /\b(welcome( to| aboard)?|getting started|thanks for (signing|joining)|start here)\b/,
  ],
  [
    'webinar-event',
    /\b(webinar|livestream|live stream|workshop|summit|conference|meetup|register (now|today)|join us|save (your|the) (seat|date)|rsvp|event (starts|reminder)|starting (soon|in))\b/,
  ],
  [
    'survey-feedback',
    /\b(survey|feedback|rate (your|us)|how did we do|review your|tell us (what|how)|share your (thoughts|experience))\b/,
  ],
  [
    'promotional',
    /(\d+% off|\b(on sale|sale (ends|starts)|flash sale|deals?|discount|coupon|promo code|limited[- ]time|special offer|exclusive offer|offer ends|free trial|last chance|ends (today|tonight|soon)|black friday|cyber monday|save \$?\d+|early bird|don't miss)\b)/,
  ],
  [
    'newsletter',
    /\b(newsletter|digest|weekly|monthly|this week|roundup|edition|issue #?\d*|top stories|what's new|new posts?|posted new|new notes|read more|recommended (for you|reading)|trending|explained|guide to|tips|how to)\b/,
  ],
  [
    'system-notification',
    /\b(notification|reminder|has been|was (updated|changed|paused)|your account|terms of service|privacy policy|started following|liked your|commented|mentioned you|tagged you|wants to be friends|friend request|sent you a message|new message|invited you|reposted|shared (a|your))\b/,
  ],
];

/**
 * What well-known senders send when nothing in the subject says otherwise: a Reddit or Quora email
 * is a digest of posts whose subject is just a post title, and no keyword can see that. Checked
 * after the keyword patterns, so GitHub's security alerts are still security alerts.
 */
const BRAND_INTENTS: Record<string, string> = {
  'quora.com': 'newsletter',
  'redditmail.com': 'newsletter',
  'reddit.com': 'newsletter',
  'substack.com': 'newsletter',
  'medium.com': 'newsletter',
  'beehiiv.com': 'newsletter',
  'twitter.com': 'newsletter',
  'x.com': 'newsletter',
  'pinterest.com': 'newsletter',
  'github.com': 'system-notification',
  'gitlab.com': 'system-notification',
  'vercel.com': 'system-notification',
  'netlify.com': 'system-notification',
  'supabase.com': 'system-notification',
  'render.com': 'system-notification',
  'heroku.com': 'system-notification',
  'facebookmail.com': 'system-notification',
  'tiktok.com': 'system-notification',
  'instagram.com': 'system-notification',
  'linkedin.com': 'job-match',
  'indeed.com': 'job-match',
  'glassdoor.com': 'job-match',
  'ziprecruiter.com': 'job-match',
  'lensa.com': 'job-match',
  'jobright.ai': 'job-match',
  'codecademy.com': 'promotional',
  'coursera.org': 'promotional',
  'datacamp.com': 'promotional',
  'dell.com': 'promotional',
  'vistaprint.com': 'promotional',
};

/** Well-known senders whose area of life is not in question, by registrable domain. */
const BRAND_DOMAINS: Record<string, string> = {
  'linkedin.com': 'career',
  'indeed.com': 'career',
  'glassdoor.com': 'career',
  'ziprecruiter.com': 'career',
  'monster.com': 'career',
  'wellfound.com': 'career',
  'upwork.com': 'career',
  'fiverr.com': 'career',
  'github.com': 'development',
  'gitlab.com': 'development',
  'bitbucket.org': 'development',
  'vercel.com': 'development',
  'netlify.com': 'development',
  'supabase.com': 'development',
  'render.com': 'development',
  'heroku.com': 'development',
  'docker.com': 'development',
  'stackoverflow.com': 'development',
  'npmjs.com': 'development',
  'atlassian.com': 'development',
  'jetbrains.com': 'development',
  'coursera.org': 'education',
  'udemy.com': 'education',
  'edx.org': 'education',
  'khanacademy.org': 'education',
  'duolingo.com': 'education',
  'codecademy.com': 'education',
  'datacamp.com': 'education',
  'facebookmail.com': 'social',
  'facebook.com': 'social',
  'instagram.com': 'social',
  'tiktok.com': 'social',
  'twitter.com': 'social',
  'x.com': 'social',
  'reddit.com': 'social',
  'redditmail.com': 'social',
  'quora.com': 'social',
  'pinterest.com': 'social',
  'discord.com': 'social',
  'snapchat.com': 'social',
  'whatsapp.com': 'social',
  'telegram.org': 'social',
  'paypal.com': 'finance',
  'stripe.com': 'finance',
  'wise.com': 'finance',
  'revolut.com': 'finance',
  'payoneer.com': 'finance',
  'binance.com': 'finance',
  'coinbase.com': 'finance',
  'netflix.com': 'entertainment',
  'spotify.com': 'entertainment',
  'youtube.com': 'entertainment',
  'twitch.tv': 'entertainment',
  'steampowered.com': 'entertainment',
  'epicgames.com': 'entertainment',
  'playstation.com': 'entertainment',
  'xbox.com': 'entertainment',
  'battle.net': 'entertainment',
  'primevideo.com': 'entertainment',
  'disneyplus.com': 'entertainment',
  'amazon.com': 'shopping',
  'ebay.com': 'shopping',
  'aliexpress.com': 'shopping',
  'temu.com': 'shopping',
  'shein.com': 'shopping',
  'etsy.com': 'shopping',
  'walmart.com': 'shopping',
  'jumia.com': 'shopping',
};

/** Words in a sender's domain that name its area of life. Checked only when no brand matched. */
const DOMAIN_WORDS: Array<[string, RegExp]> = [
  ['education', /(^|[.-])(edu|ac|university|univ|college|school|academy|learn|course)/],
  ['finance', /(bank|pay|card|wallet|finance|invest|trade|trading|capital|credit|loan|crypto)/],
  ['career', /(job|career|hiring|recruit|talent|resume|staffing)/],
  ['shopping', /(shop|store|market|deals|mall|boutique)/],
  ['entertainment', /(game|gaming|music|movie|film|stream|tv|play)/],
  ['development', /(dev|code|cloud|api|tech|software|data|host)/],
];

const SUBJECT_DOMAINS: Array<[string, RegExp]> = [
  ['career', /\b(job|jobs|hiring|recruiter|resume|cv|interview|internship|career)\b/],
  ['finance', /\b(bank|payment|invoice|card|transfer|transaction|balance|wallet|deposit)\b/],
  ['education', /\b(course|class|lesson|exam|admission|scholarship|university|semester|tuition)\b/],
  ['shopping', /\b(order|shipped|delivery|cart|shipping|package)\b/],
  ['development', /\b(deploy|build|repository|pull request|api|commit|server|database)\b/],
];

function text(message: HeuristicMessage): string {
  return `${message.subject ?? ''} ${message.snippet ?? ''}`.toLowerCase().replace(/\s+/g, ' ');
}

/** What the subject or snippet says outright: "verification code", "50% off". */
export function keywordIntent(message: HeuristicMessage): string | null {
  const body = text(message);
  for (const [intent, pattern] of INTENT_PATTERNS) {
    if (pattern.test(body)) return intent;
  }
  return null;
}

/** What a sender usually sends, then which Gmail tab it is in: the guesses of last resort. */
export function fallbackIntent(message: HeuristicMessage): string | null {
  const identity = emailIdentity(message.senderEmail);
  const brand =
    BRAND_INTENTS[identity.registrableDomain] ?? BRAND_INTENTS[identity.senderDomain] ?? null;
  if (brand) return brand;
  // Gmail already decided what kind of mail this is; that is better than nothing at all.
  const labels = new Set(message.labelIds ?? []);
  if (labels.has('CATEGORY_PROMOTIONS')) return 'promotional';
  if (labels.has('CATEGORY_FORUMS') || labels.has('CATEGORY_SOCIAL')) {
    return 'system-notification';
  }
  // Measured on a real mailbox, the Updates tab is twice as often a newsletter or digest as an
  // account notice.
  if (labels.has('CATEGORY_UPDATES')) return 'newsletter';
  return null;
}

export function heuristicIntent(message: HeuristicMessage): string | null {
  return keywordIntent(message) ?? fallbackIntent(message);
}

/** A well-known sender's area of life: public knowledge, true for everyone. */
export function brandDomain(message: HeuristicMessage): string | null {
  const identity = emailIdentity(message.senderEmail);
  return BRAND_DOMAINS[identity.registrableDomain] ?? BRAND_DOMAINS[identity.senderDomain] ?? null;
}

/** Words in the sender's host or the subject, then the Social tab. */
export function guessedDomain(message: HeuristicMessage): string | null {
  const identity = emailIdentity(message.senderEmail);
  const host = identity.senderDomain;
  for (const [domain, pattern] of DOMAIN_WORDS) {
    if (host && pattern.test(host)) return domain;
  }
  const subject = (message.subject ?? '').toLowerCase();
  for (const [domain, pattern] of SUBJECT_DOMAINS) {
    if (pattern.test(subject)) return domain;
  }
  if ((message.labelIds ?? []).includes('CATEGORY_SOCIAL')) return 'social';
  return null;
}

export function heuristicDomain(message: HeuristicMessage): string | null {
  return brandDomain(message) ?? guessedDomain(message);
}

/**
 * Both facets by heuristic, restricted to what the mailbox approved. Either may still be null —
 * a personal email from a friend has no area of life a keyword can name — and the folder view
 * then files it under its sender, which is still a folder rather than nowhere.
 */
export function heuristicFacets(
  message: HeuristicMessage,
  approved: { domain: ReadonlySet<string>; intent: ReadonlySet<string> },
): HeuristicFacets {
  const domain = heuristicDomain(message);
  const intent = heuristicIntent(message);
  return {
    domain: domain && approved.domain.has(domain) ? domain : null,
    intent: intent && approved.intent.has(intent) ? intent : null,
  };
}
