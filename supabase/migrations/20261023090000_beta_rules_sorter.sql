-- Sorting without a model for everyone but the operator, inside a bounded history window.

-- A decision made by the built-in keyword and Gmail-category heuristics rather than by a routing
-- rule or the model, recorded as such so its share of a mailbox can be measured.
alter type public.facet_source add value if not exists 'HEURISTIC';

-- Routing rules that belong to no mailbox: sender domains and subject phrases whose facets were
-- consistent in a reference mailbox, applied to everyone sorted without a model. They live here and
-- never in the repository, which is public — a list of senders is a description of a person.
create table public.reference_classification_rules (
  id uuid primary key default gen_random_uuid(),
  rule_kind public.routing_rule_kind not null,
  match_value text not null check (char_length(match_value) between 3 and 320),
  facet_domain text,
  facet_intent text,
  sample_count integer not null check (sample_count > 0),
  share real not null check (share > 0 and share <= 1),
  built_at timestamptz not null default now(),
  constraint reference_classification_rules_kind_value_unique unique (rule_kind, match_value),
  constraint reference_classification_rules_assigns_something
    check (facet_domain is not null or facet_intent is not null)
);

alter table public.reference_classification_rules enable row level security;
alter table public.reference_classification_rules force row level security;
revoke all on table public.reference_classification_rules from public, anon, authenticated;

-- How many days of history a mailbox is sorted over, counted back from its first connection. Null
-- is the deployment's MAIL_HISTORY_DAYS; a longer window per mailbox is what a subscription buys.
alter table public.connected_google_accounts
  add column mail_history_days integer
    check (mail_history_days is null or mail_history_days between 1 and 36500);
