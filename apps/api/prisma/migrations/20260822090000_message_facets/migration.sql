-- Facets replace "assign a path" with "assign facets, then pivot facets into folders".
--
-- A single tree can express only one ordering of the things a message is about, so a mailbox whose
-- mail is Netflix-and-a-failed-payment, or a job-alert-that-is-also-career, has no leaf to go in:
-- 85.9% of this account came back NONE, and not because the classifier was wrong — 893 of its
-- 1,332 filings were 0.95 or better. It was being asked a question with no right answer.
--
-- Three orthogonal facets per message, each independently assigned:
--   entity  derived from the sender domain in code. No model call, so no tokens and no mistakes.
--   domain  the area of life, from a closed vocabulary the mailbox owner approved.
--   intent  what the message wants or what happened, from a second approved vocabulary.
--
-- This migration stores facets and teaches routing rules to speak them. It changes nothing about
-- how mail is filed: Gmail still receives exactly one label per message, or none, and that path is
-- untouched until the pivot lands. Nothing here writes to Gmail.

create type public.facet_source as enum ('RULE', 'MODEL');

create table public.message_facets (
  id uuid primary key default gen_random_uuid(),
  connected_google_account_id uuid not null
    references public.connected_google_accounts(id) on delete cascade,
  -- The message this describes. Cascade, because facets for a deleted message are meaningless.
  gmail_message_id uuid not null
    references public.gmail_message_metadata(id) on delete cascade,

  -- Derived from sender_email, so it is null exactly when the sender carries no usable domain.
  -- A message with no brand still has a domain and an intent and must still be classifiable.
  entity text check (entity is null or char_length(entity) between 1 and 64),
  -- Closed vocabularies. Null means "not decided", which is a different thing from a value that
  -- happens to mean nothing fits: the classifier either places a message on an axis or it does not.
  domain text check (domain is null or char_length(domain) between 1 and 64),
  intent text check (intent is null or char_length(intent) between 1 and 64),

  entity_confidence double precision not null default 1
    check (entity_confidence between 0 and 1),
  domain_confidence double precision check (domain_confidence between 0 and 1),
  intent_confidence double precision check (intent_confidence between 0 and 1),

  -- Which mechanism decided the two model facets. Entity is always derived and never a decision.
  source public.facet_source not null,
  -- The vocabulary and prompt this was classified under, so a re-run after a vocabulary change is
  -- distinguishable from a re-run after a model change.
  prompt_version text not null check (char_length(prompt_version) between 1 and 80),
  -- Same shape as automation_message_actions.input_hash: re-classify only when the input changed.
  input_hash text not null check (char_length(input_hash) between 1 and 128),
  classified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Facet values are kebab-case like every vocabulary value, and entity is normalised the same way
  -- so "redditmail" and "reddit" cannot both exist as brands.
  constraint message_facets_entity_shape_check check (entity is null or entity ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
  constraint message_facets_domain_shape_check check (domain is null or domain ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
  constraint message_facets_intent_shape_check check (intent is null or intent ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
  -- A facet that was decided carries the confidence of that decision, and one that was not carries
  -- no confidence at all. Without this a null domain could still arrive with 0.97 attached to it.
  -- Named "decided", not "confidence": Postgres already auto-names the column's own range check
  -- message_facets_domain_confidence_check, and a second constraint by that name is rejected.
  constraint message_facets_domain_decided_check check ((domain is null) = (domain_confidence is null)),
  constraint message_facets_intent_decided_check check ((intent is null) = (intent_confidence is null))
);

-- One facet row per message: this row IS the checkpoint. A resumed run skips every message that
-- already has one, exactly as the filing run skips messages with an action row.
create unique index message_facets_message_unique_idx
  on public.message_facets(gmail_message_id);

create index message_facets_account_classified_idx
  on public.message_facets(connected_google_account_id, classified_at desc);
-- The pivot reads facets grouped by combination; these are the two orderings it asks for.
create index message_facets_account_entity_intent_idx
  on public.message_facets(connected_google_account_id, entity, intent);
create index message_facets_account_domain_intent_idx
  on public.message_facets(connected_google_account_id, domain, intent);

create trigger message_facets_set_updated_at
before update on public.message_facets
for each row execute function public.set_updated_at();

alter table public.message_facets enable row level security;
alter table public.message_facets force row level security;
revoke all on table public.message_facets from public, anon, authenticated;

-- Routing rules learn to speak facets.
--
-- A rule that resolves to a leaf path can only ever fire for mail that belongs in that one folder.
-- A rule that resolves to an intent generalises: "subject contains 'insufficient funds'" is the
-- same fact whether the sender is a bank, a broker, or a streaming service, and that
-- generalisation is the main thing facets buy.
--
-- Both column sets are populated through the transition. Every existing row keeps its label_name
-- and label_path exactly as they are, and the filing path that reads them is untouched; the facet
-- columns are nullable because rules written before this migration have no facet values and must
-- not be invalidated by their arrival.
--
-- The label columns become nullable for the opposite case: a rule learned as "subject contains
-- 'insufficient funds' -> intent payment-failed" resolves to a facet and to no folder at all,
-- because which folder that becomes is a pivot decision that has not been made yet. Writing a
-- placeholder path to satisfy a not-null would put a folder that does not exist into the table
-- the filing path trusts. Nothing is dropped and no existing value changes: the constraint below
-- keeps every row resolving to something, and a row with no label is simply invisible to the
-- filing path, which looks its rules up by label name.
alter table public.learned_classification_patterns
  add column facet_domain text
    check (facet_domain is null or facet_domain ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
  add column facet_intent text
    check (facet_intent is null or facet_intent ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
  -- The brand whose mail taught this rule. A subject rule that later fires for a different entity
  -- is the generalisation facets exist for, and this column is what makes that countable rather
  -- than merely claimed.
  add column learned_from_entity text
    check (learned_from_entity is null or char_length(learned_from_entity) between 1 and 64),
  alter column label_name drop not null,
  alter column label_path drop not null,
  -- A rule that matches mail and then has nothing to say about it is not a rule.
  add constraint learned_patterns_resolves_check check (
    label_name is not null or facet_domain is not null or facet_intent is not null
  ),
  -- A label rule still needs both halves; only a facet-only rule may omit them.
  add constraint learned_patterns_label_pair_check check (
    (label_name is null) = (label_path is null)
  );

create index learned_patterns_facet_idx
  on public.learned_classification_patterns(connected_google_account_id, active)
  where facet_domain is not null or facet_intent is not null;
