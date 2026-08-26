-- A vocabulary belongs to a mailbox, not to the repository.
--
-- `features/label-discovery/facets.ts` holds the approved domains and intents as a checked-in
-- constant, dated to one mailbox owner on one day in August 2026. `facet-vocabulary.ts` can already
-- design a vocabulary from a real mailbox's evidence, but its result was never persisted anywhere,
-- so a second user would be classified against a stranger's taxonomy. That blocks multi-user
-- structurally rather than incidentally: no amount of authentication work makes "career, finance,
-- education" the right set of domains for somebody else's mail.
--
-- The propose -> confirm shape is the labels flow, deliberately. A grounded proposal is written as
-- PROPOSED and changes nothing; a person approves it; only then does the classifier speak it. The
-- alternative -- design a vocabulary and start using it -- is the thing this codebase has refused
-- to do everywhere else.
create type public.facet_vocabulary_status as enum ('PROPOSED', 'APPROVED');

create table public.facet_vocabularies (
  id uuid primary key default gen_random_uuid(),
  connected_google_account_id uuid not null
    references public.connected_google_accounts(id) on delete cascade,
  -- Only the two model facets. `entity` is derived from the sender domain in code and is never a
  -- vocabulary: there is nothing to approve about "the brand that sent this".
  facet text not null check (facet in ('domain', 'intent')),
  -- The same slug shape the classifier validates against and the pivot spells folders from.
  name text not null check (
    name ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' and char_length(name) between 2 and 64
  ),
  -- One sentence, precise enough to route by. Sent to the model verbatim, which is why it is
  -- stored rather than regenerated: the words the person approved are the words the model sees.
  definition text not null check (char_length(definition) between 10 and 400),
  status public.facet_vocabulary_status not null default 'PROPOSED',
  -- The order the values were reviewed in, so a prompt reads the same way twice.
  position integer not null default 0 check (position >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Status is part of the key: the same name may sit in a pending proposal and in the approved set
-- at once, and those are two different facts about it.
create unique index facet_vocabularies_account_value_unique_idx
  on public.facet_vocabularies(connected_google_account_id, facet, status, name);
create index facet_vocabularies_account_status_idx
  on public.facet_vocabularies(connected_google_account_id, status);

alter table public.facet_vocabularies enable row level security;
alter table public.facet_vocabularies force row level security;
revoke all on table public.facet_vocabularies from public, anon, authenticated;

-- Seed every account that exists today with the checked-in vocabulary, as APPROVED.
--
-- This is not a default for new accounts -- they get nothing until they approve something, and the
-- classifier refuses to run until they do. It is a statement of fact about the accounts that are
-- already here: these values ARE what their owner approved on 2026-08-21, and 9,431 messages are
-- already classified against them. Leaving them unseeded would invalidate every one of those rows.
insert into public.facet_vocabularies
  (connected_google_account_id, facet, name, definition, status, position)
select account.id, seed.facet, seed.name, seed.definition, 'APPROVED', seed.position
from public.connected_google_accounts account
cross join (values
  ('domain', 'career', 'Job applications, hiring and recruiting, resumes, professional networking, and work opportunities.', 0),
  ('domain', 'development', 'Software engineering, code repositories, cloud infrastructure, APIs, and developer tooling.', 1),
  ('domain', 'education', 'University admissions, scholarships, courses, transcripts, and study programmes.', 2),
  ('domain', 'social', 'Social media activity, direct messages, community and forum threads, and friend or follower connections.', 3),
  ('domain', 'finance', 'Banking, payments, invoices, receipts, card and crypto transactions, and account balances.', 4),
  ('domain', 'entertainment', 'Streaming, video, music, games, and leisure content of every kind, including gaming stores and launches.', 5),
  ('domain', 'shopping', 'Retail orders, deliveries and shipping, store accounts, and purchase history for physical or digital goods.', 6),
  ('intent', 'verification', 'An action is required of the reader to prove identity or access: a one-time code, a confirmation link, or a sign-in approval.', 0),
  ('intent', 'welcome', 'An account was created or onboarding has begun, and no action is required of the reader.', 1),
  ('intent', 'newsletter', 'A periodic or broadcast roundup: digests, blog posts, articles, release notes, or community summaries.', 2),
  ('intent', 'promotional', 'Advertising: sales, discounts, limited-time offers, coupons, upgrade incentives, or event tickets.', 3),
  ('intent', 'application-received', 'An acknowledgment that something the reader submitted has been received, with no decision yet.', 4),
  ('intent', 'application-outcome', 'A response to something the reader submitted: a rejection, an interview invitation, an offer, or an admission decision.', 5),
  ('intent', 'job-match', 'An alert about job openings, headhunter recommendations, or opportunities matched to the reader.', 6),
  ('intent', 'security-alert', 'A security incident, unusual or new sign-in, leaked credential, or password change notification.', 7),
  ('intent', 'system-notification', 'An operational notice about a service: updates, downtime, paused projects, build or deployment failures, and configuration changes.', 8),
  ('intent', 'invoice-receipt', 'A receipt, order confirmation, invoice, or billing statement for a payment that succeeded.', 9),
  ('intent', 'payment-failed', 'A payment did not go through: a declined charge, insufficient funds, an expired subscription, or an account on hold.', 10),
  ('intent', 'webinar-event', 'An invitation or reminder for a webinar, workshop, open day, live conference, or scheduled session.', 11),
  ('intent', 'survey-feedback', 'A request for the reader’s feedback, review, rating, or survey response.', 12)
) as seed(facet, name, definition, position)
on conflict do nothing;
