create type public.dynamic_label_candidate_type as enum (
  'SOURCE', 'ORGANIZATION', 'TOPIC', 'SUBSCRIPTION', 'PROJECT', 'WORKFLOW'
);
create type public.dynamic_label_candidate_status as enum (
  'PENDING', 'APPROVED', 'REJECTED', 'DEFERRED', 'MERGED', 'CREATED',
  'SUPERSEDED', 'FAILED'
);
create type public.label_candidate_decision as enum (
  'APPROVE', 'RENAME_AND_APPROVE', 'REJECT', 'DEFER', 'MERGE'
);
create type public.label_discovery_run_status as enum ('RUNNING', 'COMPLETED', 'FAILED');

create table public.dynamic_label_candidates (
  id uuid primary key default gen_random_uuid(),
  connected_google_account_id uuid not null
    references public.connected_google_accounts(id) on delete cascade,
  candidate_type public.dynamic_label_candidate_type not null,
  source_key text not null check (char_length(source_key) between 1 and 300),
  suggested_leaf_name text not null check (char_length(suggested_leaf_name) between 2 and 60),
  suggested_full_path text not null check (char_length(suggested_full_path) between 1 and 225),
  normalized_name text not null check (char_length(normalized_name) between 2 and 80),
  status public.dynamic_label_candidate_status not null default 'PENDING',
  confidence double precision not null check (confidence between 0 and 1),
  message_count integer not null check (message_count >= 0),
  thread_count integer not null check (thread_count >= 0),
  first_message_at timestamptz,
  last_message_at timestamptz,
  dominant_category public.classification_category,
  category_agreement double precision not null check (category_agreement between 0 and 1),
  source_agreement double precision not null check (source_agreement between 0 and 1),
  reason_codes text[] not null default '{}' check (cardinality(reason_codes) <= 16),
  discovery_version text not null,
  naming_version text not null,
  input_hash text not null check (char_length(input_hash) = 64),
  provider text not null default 'rules',
  model text,
  merged_into_candidate_id uuid
    references public.dynamic_label_candidates(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_discovered_at timestamptz not null default now(),
  constraint dynamic_label_candidates_time_check check (
    first_message_at is null or last_message_at is null or first_message_at <= last_message_at
  ),
  constraint dynamic_label_candidates_merge_state_check check (
    (status = 'MERGED' and merged_into_candidate_id is not null)
    or (status <> 'MERGED' and merged_into_candidate_id is null)
  ),
  constraint dynamic_label_candidates_not_self_merged_check check (
    merged_into_candidate_id is null or merged_into_candidate_id <> id
  )
);

create table public.dynamic_label_candidate_messages (
  candidate_id uuid not null
    references public.dynamic_label_candidates(id) on delete cascade,
  gmail_message_id uuid not null
    references public.gmail_message_metadata(id) on delete cascade,
  association_score double precision not null check (association_score between 0 and 1),
  reason_codes text[] not null default '{}' check (cardinality(reason_codes) <= 12),
  created_at timestamptz not null default now(),
  primary key (candidate_id, gmail_message_id)
);

create table public.label_decisions (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null
    references public.dynamic_label_candidates(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  decision public.label_candidate_decision not null,
  original_suggested_name text not null,
  final_leaf_name text,
  final_full_path text,
  merged_into_candidate_id uuid
    references public.dynamic_label_candidates(id) on delete restrict,
  decision_reason text check (decision_reason is null or char_length(decision_reason) <= 500),
  created_at timestamptz not null default now(),
  constraint label_decisions_approval_fields_check check (
    (decision in ('APPROVE', 'RENAME_AND_APPROVE')
      and final_leaf_name is not null and final_full_path is not null)
    or (decision not in ('APPROVE', 'RENAME_AND_APPROVE')
      and final_leaf_name is null and final_full_path is null)
  ),
  constraint label_decisions_merge_fields_check check (
    (decision = 'MERGE' and merged_into_candidate_id is not null)
    or (decision <> 'MERGE' and merged_into_candidate_id is null)
  )
);

create table public.label_discovery_runs (
  id uuid primary key default gen_random_uuid(),
  connected_google_account_id uuid not null
    references public.connected_google_accounts(id) on delete cascade,
  status public.label_discovery_run_status not null default 'RUNNING',
  messages_analyzed integer not null default 0 check (messages_analyzed >= 0),
  groups_discovered integer not null default 0 check (groups_discovered >= 0),
  candidates_created integer not null default 0 check (candidates_created >= 0),
  candidates_reused integer not null default 0 check (candidates_reused >= 0),
  candidates_rejected_by_rules integer not null default 0
    check (candidates_rejected_by_rules >= 0),
  provider_calls integer not null default 0 check (provider_calls >= 0),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now()
);

create table public.label_discovery_states (
  id uuid primary key default gen_random_uuid(),
  connected_google_account_id uuid not null
    references public.connected_google_accounts(id) on delete cascade,
  lease_token text,
  lease_expires_at timestamptz,
  active_run_id uuid,
  last_run_started_at timestamptz,
  last_run_completed_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint label_discovery_states_lease_pair_check check (
    (lease_token is null and lease_expires_at is null and active_run_id is null)
    or (lease_token is not null and lease_expires_at is not null)
  )
);

create unique index dynamic_label_candidates_account_hash_unique_idx
  on public.dynamic_label_candidates(connected_google_account_id, input_hash);
create unique index dynamic_label_candidates_active_path_unique_idx
  on public.dynamic_label_candidates(connected_google_account_id, lower(suggested_full_path))
  where status in ('PENDING', 'APPROVED', 'DEFERRED', 'CREATED');
create index dynamic_label_candidates_account_status_idx
  on public.dynamic_label_candidates(
    connected_google_account_id, status, last_discovered_at desc
  );
create index dynamic_label_candidates_account_name_idx
  on public.dynamic_label_candidates(connected_google_account_id, normalized_name);
create index dynamic_label_candidates_merged_into_candidate_id_idx
  on public.dynamic_label_candidates(merged_into_candidate_id);
create index dynamic_label_candidate_messages_gmail_message_id_idx
  on public.dynamic_label_candidate_messages(gmail_message_id);
create index label_decisions_candidate_created_idx
  on public.label_decisions(candidate_id, created_at desc);
create index label_decisions_user_created_idx
  on public.label_decisions(user_id, created_at desc);
create index label_decisions_merged_into_candidate_id_idx
  on public.label_decisions(merged_into_candidate_id);
create index label_discovery_runs_account_started_idx
  on public.label_discovery_runs(connected_google_account_id, started_at desc);
create index label_discovery_runs_status_idx on public.label_discovery_runs(status);
create unique index label_discovery_states_account_unique_idx
  on public.label_discovery_states(connected_google_account_id);
create index label_discovery_states_lease_expiry_idx
  on public.label_discovery_states(lease_expires_at);

create function public.validate_dynamic_label_association_account()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if not exists (
    select 1
    from public.dynamic_label_candidates candidate
    join public.gmail_message_metadata message
      on message.connected_google_account_id = candidate.connected_google_account_id
    where candidate.id = new.candidate_id and message.id = new.gmail_message_id
  ) then
    raise exception 'LABEL_CANDIDATE_ASSOCIATION_ACCOUNT_MISMATCH';
  end if;
  return new;
end;
$$;

create function public.validate_dynamic_label_merge()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  target_account_id uuid;
  target_status public.dynamic_label_candidate_status;
begin
  if new.merged_into_candidate_id is null then return new; end if;
  select connected_google_account_id, status
    into target_account_id, target_status
    from public.dynamic_label_candidates
    where id = new.merged_into_candidate_id;
  if target_account_id is distinct from new.connected_google_account_id then
    raise exception 'LABEL_CANDIDATE_MERGE_CROSS_ACCOUNT';
  end if;
  if target_status in ('REJECTED', 'MERGED', 'SUPERSEDED', 'FAILED') then
    raise exception 'LABEL_CANDIDATE_MERGE_TARGET_INACTIVE';
  end if;
  if exists (
    with recursive chain(id, merged_into_candidate_id) as (
      select id, merged_into_candidate_id
      from public.dynamic_label_candidates
      where id = new.merged_into_candidate_id
      union all
      select candidate.id, candidate.merged_into_candidate_id
      from public.dynamic_label_candidates candidate
      join chain on candidate.id = chain.merged_into_candidate_id
    )
    select 1 from chain where id = new.id
  ) then
    raise exception 'LABEL_CANDIDATE_MERGE_CYCLE';
  end if;
  return new;
end;
$$;

create function public.prevent_label_decision_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'LABEL_DECISIONS_ARE_IMMUTABLE';
end;
$$;

create trigger dynamic_label_candidates_set_updated_at
before update on public.dynamic_label_candidates
for each row execute function public.set_updated_at();
create trigger label_discovery_states_set_updated_at
before update on public.label_discovery_states
for each row execute function public.set_updated_at();
create trigger dynamic_label_candidate_messages_account_guard
before insert or update on public.dynamic_label_candidate_messages
for each row execute function public.validate_dynamic_label_association_account();
create trigger dynamic_label_candidates_merge_guard
before insert or update of merged_into_candidate_id on public.dynamic_label_candidates
for each row execute function public.validate_dynamic_label_merge();
create trigger label_decisions_immutable_guard
before update or delete on public.label_decisions
for each row execute function public.prevent_label_decision_mutation();

alter table public.dynamic_label_candidates enable row level security;
alter table public.dynamic_label_candidates force row level security;
alter table public.dynamic_label_candidate_messages enable row level security;
alter table public.dynamic_label_candidate_messages force row level security;
alter table public.label_decisions enable row level security;
alter table public.label_decisions force row level security;
alter table public.label_discovery_runs enable row level security;
alter table public.label_discovery_runs force row level security;
alter table public.label_discovery_states enable row level security;
alter table public.label_discovery_states force row level security;

revoke all on table public.dynamic_label_candidates from public, anon, authenticated;
revoke all on table public.dynamic_label_candidate_messages from public, anon, authenticated;
revoke all on table public.label_decisions from public, anon, authenticated;
revoke all on table public.label_discovery_runs from public, anon, authenticated;
revoke all on table public.label_discovery_states from public, anon, authenticated;
revoke all on function public.validate_dynamic_label_association_account()
  from public, anon, authenticated;
revoke all on function public.validate_dynamic_label_merge()
  from public, anon, authenticated;
revoke all on function public.prevent_label_decision_mutation()
  from public, anon, authenticated;
