create type public.classification_category as enum (
  'PRIMARY', 'WORK', 'FINANCE', 'RECEIPTS', 'ORDERS', 'TRAVEL', 'EDUCATION',
  'NEWSLETTERS', 'PROMOTIONS', 'SOCIAL', 'NOTIFICATIONS', 'SECURITY', 'SUPPORT',
  'PERSONAL', 'SPAM_SUSPECTED', 'OTHER'
);
create type public.recommended_action as enum (
  'KEEP_IN_INBOX', 'ARCHIVE_RECOMMENDED', 'REVIEW_REQUIRED',
  'IMPORTANT_RECOMMENDED', 'MUTE_RECOMMENDED', 'UNSUBSCRIBE_CANDIDATE'
);
create type public.classification_source as enum ('RULE', 'AI', 'HYBRID', 'USER');
create type public.classification_status as enum (
  'PENDING', 'COMPLETED', 'FAILED', 'NEEDS_REVIEW', 'SUPERSEDED'
);
create type public.classification_run_status as enum ('RUNNING', 'COMPLETED', 'FAILED');

create table public.classification_results (
  id uuid primary key default gen_random_uuid(),
  gmail_message_id uuid not null references public.gmail_message_metadata(id) on delete cascade,
  connected_google_account_id uuid not null
    references public.connected_google_accounts(id) on delete cascade,
  category public.classification_category not null,
  recommended_action public.recommended_action not null,
  confidence double precision not null check (confidence >= 0 and confidence <= 1),
  requires_review boolean not null,
  explanation text not null check (char_length(explanation) between 1 and 400),
  reason_codes text[] not null default '{}',
  source public.classification_source not null,
  classifier_version text not null,
  prompt_version text not null,
  taxonomy_version text not null,
  provider text not null,
  model text,
  input_hash text not null check (char_length(input_hash) = 64),
  message_metadata_hash text not null check (char_length(message_metadata_hash) = 64),
  status public.classification_status not null,
  classified_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.classification_runs (
  id uuid primary key default gen_random_uuid(),
  connected_google_account_id uuid not null
    references public.connected_google_accounts(id) on delete cascade,
  status public.classification_run_status not null default 'RUNNING',
  requested_message_count integer not null default 0 check (requested_message_count >= 0),
  processed_message_count integer not null default 0 check (processed_message_count >= 0),
  reused_result_count integer not null default 0 check (reused_result_count >= 0),
  rule_classified_count integer not null default 0 check (rule_classified_count >= 0),
  ai_classified_count integer not null default 0 check (ai_classified_count >= 0),
  provider_call_count integer not null default 0 check (provider_call_count >= 0),
  review_required_count integer not null default 0 check (review_required_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  input_units integer check (input_units is null or input_units >= 0),
  output_units integer check (output_units is null or output_units >= 0),
  provider text not null,
  model text,
  classifier_version text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now()
);

create table public.classification_states (
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
  constraint classification_states_lease_pair_check check (
    (lease_token is null and lease_expires_at is null and active_run_id is null)
    or (lease_token is not null and lease_expires_at is not null and active_run_id is not null)
    or (lease_token is not null and lease_expires_at is not null and active_run_id is null)
  )
);

create table public.user_classification_corrections (
  id uuid primary key default gen_random_uuid(),
  classification_result_id uuid not null
    references public.classification_results(id) on delete cascade,
  gmail_message_id uuid not null references public.gmail_message_metadata(id) on delete cascade,
  connected_google_account_id uuid not null
    references public.connected_google_accounts(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  original_category public.classification_category not null,
  corrected_category public.classification_category not null,
  original_recommended_action public.recommended_action not null,
  corrected_recommended_action public.recommended_action not null,
  feedback_reason text check (feedback_reason is null or char_length(feedback_reason) <= 500),
  created_at timestamptz not null default now()
);

create unique index classification_results_active_version_hash_unique_idx
  on public.classification_results (
    gmail_message_id, classifier_version, prompt_version, taxonomy_version, message_metadata_hash
  )
  where status <> 'SUPERSEDED';
create index classification_results_account_classified_idx
  on public.classification_results(connected_google_account_id, classified_at desc);
create index classification_results_review_queue_idx
  on public.classification_results(connected_google_account_id, status, requires_review);
create index classification_results_account_category_idx
  on public.classification_results(connected_google_account_id, category);
create index classification_results_gmail_message_id_idx
  on public.classification_results(gmail_message_id);

create index classification_runs_account_started_idx
  on public.classification_runs(connected_google_account_id, started_at desc);
create index classification_runs_status_idx on public.classification_runs(status);

create unique index classification_states_account_unique_idx
  on public.classification_states(connected_google_account_id);
create index classification_states_lease_expiry_idx
  on public.classification_states(lease_expires_at);

create index classification_corrections_result_created_idx
  on public.user_classification_corrections(classification_result_id, created_at desc);
create index user_classification_corrections_gmail_message_id_idx
  on public.user_classification_corrections(gmail_message_id);
create index user_classification_corrections_connected_google_account_id_idx
  on public.user_classification_corrections(connected_google_account_id);
create index classification_corrections_user_created_idx
  on public.user_classification_corrections(user_id, created_at desc);

create trigger classification_results_set_updated_at
before update on public.classification_results
for each row execute function public.set_updated_at();
create trigger classification_states_set_updated_at
before update on public.classification_states
for each row execute function public.set_updated_at();

alter table public.classification_results enable row level security;
alter table public.classification_results force row level security;
alter table public.classification_runs enable row level security;
alter table public.classification_runs force row level security;
alter table public.classification_states enable row level security;
alter table public.classification_states force row level security;
alter table public.user_classification_corrections enable row level security;
alter table public.user_classification_corrections force row level security;

revoke all on table public.classification_results from public, anon, authenticated;
revoke all on table public.classification_runs from public, anon, authenticated;
revoke all on table public.classification_states from public, anon, authenticated;
revoke all on table public.user_classification_corrections from public, anon, authenticated;

