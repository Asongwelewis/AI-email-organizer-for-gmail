-- Stage 2: user-approved labels replace the fixed classification taxonomy.
-- Automation may only apply labels the user confirmed, so label identity becomes a text name
-- owned by the account instead of a database enum.

create type public.user_label_source as enum ('AI_PROPOSED', 'USER_CREATED');

create table public.user_labels (
  id uuid primary key default gen_random_uuid(),
  connected_google_account_id uuid not null
    references public.connected_google_accounts(id) on delete cascade,
  leaf_name text not null check (char_length(leaf_name) between 1 and 60),
  full_path text not null check (char_length(full_path) between 1 and 120),
  normalized_name text not null check (char_length(normalized_name) between 1 and 120),
  source public.user_label_source not null,
  gmail_label_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_labels_account_path_unique_idx unique (connected_google_account_id, full_path)
);

create unique index user_labels_account_normalized_unique_idx
  on public.user_labels(connected_google_account_id, normalized_name);
create index user_labels_account_created_idx
  on public.user_labels(connected_google_account_id, created_at desc);

create trigger user_labels_set_updated_at
before update on public.user_labels
for each row execute function public.set_updated_at();

alter table public.user_labels enable row level security;
alter table public.user_labels force row level security;
revoke all on table public.user_labels from public, anon, authenticated;

-- Automation actions and learned patterns now record the approved label name.
alter table public.automation_message_actions add column label_name text;
update public.automation_message_actions
  set label_name = coalesce(
    nullif(split_part(label_path, '/', 2), ''),
    category::text
  );
alter table public.automation_message_actions
  alter column label_name set not null,
  add constraint automation_actions_label_name_length_check
    check (char_length(label_name) between 1 and 60);

alter table public.learned_classification_patterns add column label_name text;
update public.learned_classification_patterns
  set label_name = coalesce(
    nullif(split_part(label_path, '/', 2), ''),
    category::text
  );
alter table public.learned_classification_patterns
  alter column label_name set not null,
  add constraint learned_patterns_label_name_length_check
    check (char_length(label_name) between 1 and 60);

-- The discovery engine survives, but its dominant category is no longer an enum value.
alter table public.dynamic_label_candidates
  alter column dominant_category type text using dominant_category::text;

-- Run counters for the no-fit fallback and remaining backfill.
alter table public.automation_runs
  add column no_label_skipped_count integer not null default 0
    check (no_label_skipped_count >= 0),
  add column backlog_remaining integer not null default 0
    check (backlog_remaining >= 0);

-- classification_category has no remaining consumers.
alter table public.automation_message_actions drop column category;
alter table public.learned_classification_patterns drop column category;
drop type public.classification_category;
