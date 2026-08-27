-- Long-running work becomes observable: one run record per operation, whatever the feature.
--
-- The initial Gmail backfill walks every page of a mailbox and a filing run classifies up to 250
-- messages at one Gemini request every four seconds — roughly twenty minutes of wall clock. No
-- browser holds a request that long, so the endpoints now return 202 with a run id and the client
-- polls. Durability was already correct (leases plus checkpoints); what was missing was a place to
-- read *why* something ended.
--
-- Sentry keeps the exceptions. This table keeps the endings that are not exceptions: the daily
-- budget was reached, the provider rate-limited us, no labels are approved yet.

create type public.activity_run_kind as enum (
  'GMAIL_INITIAL_SYNC',
  'GMAIL_INCREMENTAL_SYNC',
  'GMAIL_LABEL_SYNC',
  'LABEL_PROPOSAL',
  'AUTOMATION_FILING'
);

create type public.activity_run_state as enum ('RUNNING', 'SUCCEEDED', 'STOPPED', 'FAILED');

create table public.activity_runs (
  id uuid primary key default gen_random_uuid(),
  connected_google_account_id uuid not null
    references public.connected_google_accounts(id) on delete cascade,
  kind public.activity_run_kind not null,
  state public.activity_run_state not null default 'RUNNING',
  trigger public.automation_trigger not null default 'MANUAL',
  processed_count integer not null default 0 check (processed_count >= 0),
  total_count integer check (total_count is null or total_count >= 0),
  -- Feature-specific counters for the activity view. Unified rows keep the shared fields typed;
  -- this keeps a filing run's twelve counters out of a union of every feature's columns.
  counts jsonb not null default '{}'::jsonb,
  stop_reason text check (stop_reason is null or char_length(stop_reason) between 1 and 80),
  error_code text check (error_code is null or char_length(error_code) between 1 and 80),
  -- Human-readable and already safe to show: services build these from AppError messages, which
  -- never carry tokens, provider payloads, or message content.
  error_message text check (error_message is null or char_length(error_message) between 1 and 500),
  -- The feature's own detailed record: gmail_sync_runs.id or automation_runs.id.
  feature_run_id uuid,
  -- A run whose process died leaves a RUNNING row behind. Past this, the next start reclaims it.
  expires_at timestamptz not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint activity_runs_finished_state_check check ((state = 'RUNNING') = (finished_at is null)),
  constraint activity_runs_failure_code_check check (state <> 'FAILED' or error_code is not null)
);

-- One live run per account per kind: a double-clicked button joins the run already in flight
-- instead of starting a second one.
create unique index activity_runs_account_kind_running_unique_idx
  on public.activity_runs(connected_google_account_id, kind)
  where state = 'RUNNING';

create index activity_runs_account_started_idx
  on public.activity_runs(connected_google_account_id, started_at desc);
create index activity_runs_state_expiry_idx on public.activity_runs(state, expires_at);

create trigger activity_runs_set_updated_at
before update on public.activity_runs
for each row execute function public.set_updated_at();

alter table public.activity_runs enable row level security;
alter table public.activity_runs force row level security;
revoke all on table public.activity_runs from public, anon, authenticated;
