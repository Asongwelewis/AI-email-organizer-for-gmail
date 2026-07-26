create type public.automation_run_status as enum ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED');
create type public.automation_trigger as enum ('SCHEDULED', 'MANUAL');
create type public.automation_action_status as enum (
  'PENDING', 'REVIEW_REQUIRED', 'APPLIED', 'SKIPPED', 'FAILED'
);
create type public.automation_classification_source as enum (
  'OPENAI', 'LEARNED_PATTERN', 'USER'
);

create table public.automation_settings (
  id uuid primary key default gen_random_uuid(),
  connected_google_account_id uuid not null
    references public.connected_google_accounts(id) on delete cascade,
  enabled boolean not null default true,
  schedule_hour_utc integer not null default 2 check (schedule_hour_utc between 0 and 23),
  confidence_threshold double precision not null default 0.8
    check (confidence_threshold between 0.5 and 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint automation_settings_account_unique_idx unique (connected_google_account_id)
);

create table public.automation_states (
  id uuid primary key default gen_random_uuid(),
  connected_google_account_id uuid not null
    references public.connected_google_accounts(id) on delete cascade,
  lease_token text,
  lease_expires_at timestamptz,
  active_run_id uuid,
  next_run_at timestamptz,
  last_run_started_at timestamptz,
  last_run_completed_at timestamptz,
  last_successful_run_at timestamptz,
  failure_count integer not null default 0 check (failure_count >= 0),
  last_error_code text,
  retry_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint automation_states_account_unique_idx unique (connected_google_account_id),
  constraint automation_states_lease_pair_check check (
    (lease_token is null and lease_expires_at is null and active_run_id is null)
    or (lease_token is not null and lease_expires_at is not null)
  )
);

create table public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  connected_google_account_id uuid not null
    references public.connected_google_accounts(id) on delete cascade,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  trigger public.automation_trigger not null,
  status public.automation_run_status not null default 'RUNNING',
  messages_seen integer not null default 0 check (messages_seen >= 0),
  pattern_reused_count integer not null default 0 check (pattern_reused_count >= 0),
  openai_classified_count integer not null default 0 check (openai_classified_count >= 0),
  review_required_count integer not null default 0 check (review_required_count >= 0),
  labels_created_count integer not null default 0 check (labels_created_count >= 0),
  labels_reused_count integer not null default 0 check (labels_reused_count >= 0),
  messages_labeled_count integer not null default 0 check (messages_labeled_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  provider_call_count integer not null default 0 check (provider_call_count >= 0),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  cached_input_tokens integer not null default 0 check (cached_input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  estimated_cost_microusd integer not null default 0
    check (estimated_cost_microusd >= 0),
  stopped_reason text,
  last_error_code text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint automation_runs_idempotency_unique_idx unique (idempotency_key),
  constraint automation_runs_time_check check (
    completed_at is null or completed_at >= started_at
  )
);

create table public.automation_message_actions (
  id uuid primary key default gen_random_uuid(),
  automation_run_id uuid not null references public.automation_runs(id) on delete cascade,
  connected_google_account_id uuid not null
    references public.connected_google_accounts(id) on delete cascade,
  gmail_message_id uuid not null
    references public.gmail_message_metadata(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  status public.automation_action_status not null default 'PENDING',
  category public.classification_category not null,
  label_path text not null check (
    char_length(label_path) between 1 and 225 and label_path like 'MailMind/%'
  ),
  gmail_label_id text,
  confidence double precision not null check (confidence between 0 and 1),
  source public.automation_classification_source not null,
  explanation text not null check (char_length(explanation) between 1 and 500),
  reason_codes text[] not null default '{}' check (cardinality(reason_codes) <= 16),
  input_hash text not null check (char_length(input_hash) = 64),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_retry_at timestamptz,
  last_error_code text,
  applied_at timestamptz,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint automation_actions_message_unique_idx unique (gmail_message_id)
);

create table public.learned_classification_patterns (
  id uuid primary key default gen_random_uuid(),
  connected_google_account_id uuid not null
    references public.connected_google_accounts(id) on delete cascade,
  sender_domain text not null check (char_length(sender_domain) between 1 and 253),
  category public.classification_category not null,
  label_path text not null check (
    char_length(label_path) between 1 and 225 and label_path like 'MailMind/%'
  ),
  confidence double precision not null check (confidence between 0 and 1),
  sample_count integer not null default 1 check (sample_count >= 1),
  successful_apply_count integer not null default 0 check (successful_apply_count >= 0),
  active boolean not null default true,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint learned_patterns_account_sender_unique_idx
    unique (connected_google_account_id, sender_domain)
);

create index automation_states_lease_expiry_idx on public.automation_states(lease_expires_at);
create index automation_states_next_run_idx on public.automation_states(next_run_at);
create index automation_states_retry_idx on public.automation_states(retry_at);
create index automation_runs_account_started_idx
  on public.automation_runs(connected_google_account_id, started_at desc);
create index automation_runs_status_started_idx on public.automation_runs(status, started_at);
create index automation_actions_run_status_idx
  on public.automation_message_actions(automation_run_id, status);
create index automation_actions_review_idx
  on public.automation_message_actions(
    connected_google_account_id, status, created_at desc
  );
create index automation_actions_retry_idx
  on public.automation_message_actions(status, next_retry_at)
  where status = 'FAILED';
create index automation_actions_user_created_idx
  on public.automation_message_actions(user_id, created_at desc);
create index learned_patterns_reuse_idx
  on public.learned_classification_patterns(
    connected_google_account_id, active, confidence
  );

create function public.validate_automation_action_account()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if not exists (
    select 1
    from public.automation_runs run
    join public.gmail_message_metadata message
      on message.connected_google_account_id = run.connected_google_account_id
    join public.connected_google_accounts account
      on account.id = run.connected_google_account_id
    where run.id = new.automation_run_id
      and message.id = new.gmail_message_id
      and account.id = new.connected_google_account_id
      and account.user_id = new.user_id
  ) then
    raise exception 'AUTOMATION_ACTION_ACCOUNT_MISMATCH';
  end if;
  return new;
end;
$$;

create trigger automation_settings_set_updated_at
before update on public.automation_settings
for each row execute function public.set_updated_at();
create trigger automation_states_set_updated_at
before update on public.automation_states
for each row execute function public.set_updated_at();
create trigger automation_actions_set_updated_at
before update on public.automation_message_actions
for each row execute function public.set_updated_at();
create trigger learned_patterns_set_updated_at
before update on public.learned_classification_patterns
for each row execute function public.set_updated_at();
create trigger automation_actions_account_guard
before insert or update on public.automation_message_actions
for each row execute function public.validate_automation_action_account();

alter table public.automation_settings enable row level security;
alter table public.automation_settings force row level security;
alter table public.automation_states enable row level security;
alter table public.automation_states force row level security;
alter table public.automation_runs enable row level security;
alter table public.automation_runs force row level security;
alter table public.automation_message_actions enable row level security;
alter table public.automation_message_actions force row level security;
alter table public.learned_classification_patterns enable row level security;
alter table public.learned_classification_patterns force row level security;

revoke all on table public.automation_settings from public, anon, authenticated;
revoke all on table public.automation_states from public, anon, authenticated;
revoke all on table public.automation_runs from public, anon, authenticated;
revoke all on table public.automation_message_actions from public, anon, authenticated;
revoke all on table public.learned_classification_patterns from public, anon, authenticated;
revoke all on function public.validate_automation_action_account()
  from public, anon, authenticated;
