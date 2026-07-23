create type public.gmail_sync_status as enum (
  'NOT_STARTED',
  'INITIAL_SYNC_RUNNING',
  'READY',
  'INCREMENTAL_SYNC_RUNNING',
  'LABEL_SYNC_RUNNING',
  'FAILED',
  'REAUTH_REQUIRED',
  'HISTORY_EXPIRED'
);
create type public.gmail_sync_type as enum ('INITIAL', 'INCREMENTAL', 'LABELS');
create type public.gmail_sync_run_status as enum ('RUNNING', 'COMPLETED', 'FAILED');

create table public.gmail_sync_states (
  id uuid primary key default gen_random_uuid(),
  connected_google_account_id uuid not null
    references public.connected_google_accounts(id) on delete cascade,
  status public.gmail_sync_status not null default 'NOT_STARTED',
  last_history_id text,
  initial_sync_completed_at timestamptz,
  last_sync_started_at timestamptz,
  last_sync_completed_at timestamptz,
  last_successful_sync_at timestamptz,
  next_retry_at timestamptz,
  failure_count integer not null default 0 check (failure_count >= 0),
  last_error_code text,
  last_error_at timestamptz,
  lease_token text,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gmail_sync_states_lease_pair_check check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  )
);

create table public.gmail_labels (
  id uuid primary key default gen_random_uuid(),
  connected_google_account_id uuid not null
    references public.connected_google_accounts(id) on delete cascade,
  gmail_label_id text not null,
  name text not null,
  type text not null,
  message_list_visibility text,
  label_list_visibility text,
  is_managed boolean not null default false,
  managed_purpose text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.gmail_message_metadata (
  id uuid primary key default gen_random_uuid(),
  connected_google_account_id uuid not null
    references public.connected_google_accounts(id) on delete cascade,
  gmail_message_id text not null,
  gmail_thread_id text,
  history_id text,
  internal_date timestamptz,
  subject text,
  sender_name text,
  sender_email text,
  recipient_summary text,
  snippet text,
  label_ids text[] not null default '{}',
  has_attachments boolean not null default false,
  size_estimate integer,
  is_unread boolean not null default false,
  is_starred boolean not null default false,
  is_important boolean not null default false,
  is_draft boolean not null default false,
  is_sent boolean not null default false,
  is_trashed boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_synced_at timestamptz not null default now(),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gmail_message_metadata_size_check check (
    size_estimate is null or size_estimate >= 0
  )
);

create table public.gmail_sync_runs (
  id uuid primary key default gen_random_uuid(),
  connected_google_account_id uuid not null
    references public.connected_google_accounts(id) on delete cascade,
  sync_type public.gmail_sync_type not null,
  status public.gmail_sync_run_status not null default 'RUNNING',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  messages_examined integer not null default 0 check (messages_examined >= 0),
  messages_upserted integer not null default 0 check (messages_upserted >= 0),
  messages_deleted integer not null default 0 check (messages_deleted >= 0),
  labels_upserted integer not null default 0 check (labels_upserted >= 0),
  checkpoint_history_id text,
  error_code text,
  created_at timestamptz not null default now()
);

create unique index gmail_sync_states_account_unique_idx
  on public.gmail_sync_states(connected_google_account_id);
create index gmail_sync_states_status_idx on public.gmail_sync_states(status);
create index gmail_sync_states_lease_expiry_idx on public.gmail_sync_states(lease_expires_at);
create index gmail_sync_states_next_retry_idx on public.gmail_sync_states(next_retry_at);

create unique index gmail_labels_account_label_unique_idx
  on public.gmail_labels(connected_google_account_id, gmail_label_id);
create unique index gmail_labels_account_name_unique_idx
  on public.gmail_labels(connected_google_account_id, name);
create index gmail_labels_connected_google_account_id_idx
  on public.gmail_labels(connected_google_account_id);
create index gmail_labels_account_managed_idx
  on public.gmail_labels(connected_google_account_id, is_managed);

create unique index gmail_messages_account_message_unique_idx
  on public.gmail_message_metadata(connected_google_account_id, gmail_message_id);
create index gmail_message_metadata_connected_google_account_id_idx
  on public.gmail_message_metadata(connected_google_account_id);
create index gmail_messages_account_thread_idx
  on public.gmail_message_metadata(connected_google_account_id, gmail_thread_id);
create index gmail_messages_account_date_idx
  on public.gmail_message_metadata(connected_google_account_id, internal_date desc);
create index gmail_messages_account_deleted_idx
  on public.gmail_message_metadata(connected_google_account_id, deleted_at);
create index gmail_messages_account_history_idx
  on public.gmail_message_metadata(connected_google_account_id, history_id);

create index gmail_sync_runs_account_started_idx
  on public.gmail_sync_runs(connected_google_account_id, started_at desc);
create index gmail_sync_runs_status_idx on public.gmail_sync_runs(status);

create trigger gmail_sync_states_set_updated_at
before update on public.gmail_sync_states
for each row execute function public.set_updated_at();
create trigger gmail_labels_set_updated_at
before update on public.gmail_labels
for each row execute function public.set_updated_at();
create trigger gmail_message_metadata_set_updated_at
before update on public.gmail_message_metadata
for each row execute function public.set_updated_at();

alter table public.gmail_sync_states enable row level security;
alter table public.gmail_sync_states force row level security;
alter table public.gmail_labels enable row level security;
alter table public.gmail_labels force row level security;
alter table public.gmail_message_metadata enable row level security;
alter table public.gmail_message_metadata force row level security;
alter table public.gmail_sync_runs enable row level security;
alter table public.gmail_sync_runs force row level security;

revoke all on table public.gmail_sync_states from public, anon, authenticated;
revoke all on table public.gmail_labels from public, anon, authenticated;
revoke all on table public.gmail_message_metadata from public, anon, authenticated;
revoke all on table public.gmail_sync_runs from public, anon, authenticated;
