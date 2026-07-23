-- Application-owned authentication and Google account schema.
-- These tables are accessed by the API through Prisma, not directly by browser clients.

create type public.audit_result as enum ('SUCCESS', 'FAILURE', 'DENIED', 'INFO');
create type public.google_connection_status as enum (
  'CONNECTED',
  'REAUTH_REQUIRED',
  'REVOKED',
  'DISCONNECTED',
  'ERROR'
);
create type public.oauth_purpose as enum ('LOGIN', 'CONNECT_GMAIL', 'REAUTHORIZE_GMAIL');
create type public.user_status as enum ('ACTIVE', 'SUSPENDED', 'DELETED');

create table public.users (
  id uuid primary key default gen_random_uuid(),
  google_subject text not null,
  email text not null,
  normalized_email text not null,
  email_verified boolean not null default false,
  display_name text,
  avatar_url text,
  status public.user_status not null default 'ACTIVE',
  last_login_at timestamptz(6),
  created_at timestamptz(6) not null default now(),
  updated_at timestamptz(6) not null default now(),
  deleted_at timestamptz(6),
  constraint users_google_subject_nonempty_check check (length(btrim(google_subject)) > 0),
  constraint users_email_nonempty_check check (length(btrim(email::text)) > 0),
  constraint users_normalized_email_check check (
    normalized_email::text = lower(btrim(email::text))
  ),
  constraint users_deleted_state_check check (
    (status = 'DELETED' and deleted_at is not null)
    or (status <> 'DELETED' and deleted_at is null)
  )
);

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade on update cascade,
  session_token_hash text not null,
  user_agent text,
  ip_hash text,
  expires_at timestamptz(6) not null,
  last_used_at timestamptz(6) not null default now(),
  revoked_at timestamptz(6),
  revocation_reason text,
  created_at timestamptz(6) not null default now(),
  constraint sessions_token_hash_nonempty_check check (length(btrim(session_token_hash)) > 0),
  constraint sessions_expiry_check check (expires_at > created_at),
  constraint sessions_last_used_check check (last_used_at >= created_at),
  constraint sessions_revoked_at_check check (revoked_at is null or revoked_at >= created_at),
  constraint sessions_revocation_reason_check check (
    revocation_reason is null or length(btrim(revocation_reason)) > 0
  )
);

create table public.connected_google_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade on update cascade,
  google_subject text not null,
  email text not null,
  granted_scopes text[] not null default array[]::text[],
  access_token_ciphertext text,
  access_token_iv text,
  access_token_auth_tag text,
  refresh_token_ciphertext text,
  refresh_token_iv text,
  refresh_token_auth_tag text,
  encryption_key_version integer,
  access_token_expires_at timestamptz(6),
  last_token_refresh_at timestamptz(6),
  gmail_connected boolean not null default false,
  connection_status public.google_connection_status not null default 'DISCONNECTED',
  last_connection_error_code text,
  last_connection_error_at timestamptz(6),
  created_at timestamptz(6) not null default now(),
  updated_at timestamptz(6) not null default now(),
  connected_at timestamptz(6),
  disconnected_at timestamptz(6),
  constraint connected_google_accounts_google_subject_nonempty_check check (
    length(btrim(google_subject)) > 0
  ),
  constraint connected_google_accounts_email_nonempty_check check (
    length(btrim(email::text)) > 0
  ),
  constraint connected_google_accounts_access_token_bundle_check check (
    (access_token_ciphertext is null and access_token_iv is null and access_token_auth_tag is null)
    or
    (access_token_ciphertext is not null and access_token_iv is not null and access_token_auth_tag is not null)
  ),
  constraint connected_google_accounts_refresh_token_bundle_check check (
    (refresh_token_ciphertext is null and refresh_token_iv is null and refresh_token_auth_tag is null)
    or
    (refresh_token_ciphertext is not null and refresh_token_iv is not null and refresh_token_auth_tag is not null)
  ),
  constraint connected_google_accounts_key_version_check check (
    encryption_key_version is null or encryption_key_version > 0
  ),
  constraint connected_google_accounts_token_key_check check (
    (access_token_ciphertext is null and refresh_token_ciphertext is null)
    or encryption_key_version is not null
  ),
  constraint connected_google_accounts_timestamps_check check (
    (connected_at is null or connected_at >= created_at)
    and (disconnected_at is null or disconnected_at >= created_at)
  )
);

create table public.oauth_states (
  id uuid primary key default gen_random_uuid(),
  state_hash text not null,
  purpose public.oauth_purpose not null,
  initiating_user_id uuid references public.users(id) on delete cascade on update cascade,
  initiating_session_id uuid references public.sessions(id) on delete set null on update cascade,
  code_verifier_ciphertext text,
  code_verifier_iv text,
  code_verifier_auth_tag text,
  encryption_key_version integer,
  redirect_path text,
  expires_at timestamptz(6) not null,
  used_at timestamptz(6),
  created_at timestamptz(6) not null default now(),
  constraint oauth_states_state_hash_nonempty_check check (length(btrim(state_hash)) > 0),
  constraint oauth_states_expiry_check check (expires_at > created_at),
  constraint oauth_states_used_at_check check (used_at is null or used_at >= created_at),
  constraint oauth_states_code_verifier_bundle_check check (
    (code_verifier_ciphertext is null and code_verifier_iv is null and code_verifier_auth_tag is null)
    or
    (code_verifier_ciphertext is not null and code_verifier_iv is not null and code_verifier_auth_tag is not null)
  ),
  constraint oauth_states_key_version_check check (
    (code_verifier_ciphertext is null and encryption_key_version is null)
    or (code_verifier_ciphertext is not null and encryption_key_version > 0)
  ),
  constraint oauth_states_redirect_path_check check (
    redirect_path is null
    or (redirect_path like '/%' and redirect_path not like '//%')
  )
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete set null on update cascade,
  session_id uuid references public.sessions(id) on delete set null on update cascade,
  action text not null,
  result public.audit_result not null default 'INFO',
  request_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz(6) not null default now(),
  constraint audit_logs_action_nonempty_check check (length(btrim(action)) > 0),
  constraint audit_logs_metadata_object_check check (jsonb_typeof(metadata) = 'object')
);

create unique index users_google_subject_unique_idx on public.users(google_subject);
create unique index users_normalized_email_unique_idx on public.users(normalized_email);
create index users_created_at_idx on public.users(created_at desc);
create index users_status_idx on public.users(status);

create unique index sessions_token_hash_unique_idx on public.sessions(session_token_hash);
create index sessions_cleanup_idx on public.sessions(expires_at, revoked_at);
create index sessions_expires_at_idx on public.sessions(expires_at);
create index sessions_user_id_idx on public.sessions(user_id);

create unique index connected_google_accounts_user_subject_unique_idx
  on public.connected_google_accounts(user_id, google_subject);
create index connected_google_accounts_email_idx on public.connected_google_accounts(email);
create index connected_google_accounts_google_subject_idx
  on public.connected_google_accounts(google_subject);
create index connected_google_accounts_status_idx
  on public.connected_google_accounts(connection_status);
create index connected_google_accounts_user_id_idx
  on public.connected_google_accounts(user_id);

create unique index oauth_states_state_hash_unique_idx on public.oauth_states(state_hash);
create index oauth_states_expiry_idx on public.oauth_states(expires_at);
create index oauth_states_initiating_user_idx on public.oauth_states(initiating_user_id);
create index oauth_states_purpose_idx on public.oauth_states(purpose);

create index audit_logs_action_idx on public.audit_logs(action);
create index audit_logs_created_at_idx on public.audit_logs(created_at desc);
create index audit_logs_result_idx on public.audit_logs(result);
create index audit_logs_session_id_idx on public.audit_logs(session_id);
create index audit_logs_user_created_idx on public.audit_logs(user_id, created_at desc);
create index audit_logs_user_id_idx on public.audit_logs(user_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger users_set_updated_at
before update on public.users
for each row execute function public.set_updated_at();

create trigger connected_google_accounts_set_updated_at
before update on public.connected_google_accounts
for each row execute function public.set_updated_at();

alter table public.users enable row level security;
alter table public.sessions enable row level security;
alter table public.connected_google_accounts enable row level security;
alter table public.oauth_states enable row level security;
alter table public.audit_logs enable row level security;

alter table public.users force row level security;
alter table public.sessions force row level security;
alter table public.connected_google_accounts force row level security;
alter table public.oauth_states force row level security;
alter table public.audit_logs force row level security;

revoke all on table public.users from anon, authenticated;
revoke all on table public.sessions from anon, authenticated;
revoke all on table public.connected_google_accounts from anon, authenticated;
revoke all on table public.oauth_states from anon, authenticated;
revoke all on table public.audit_logs from anon, authenticated;

grant all on table public.users to service_role;
grant all on table public.sessions to service_role;
grant all on table public.connected_google_accounts to service_role;
grant all on table public.oauth_states to service_role;
grant all on table public.audit_logs to service_role;

comment on table public.users is 'Application users authenticated with Google OAuth.';
comment on table public.sessions is 'Hashed application sessions; raw tokens are never stored.';
comment on table public.connected_google_accounts is 'Encrypted Google OAuth credentials and Gmail connection state.';
comment on table public.oauth_states is 'Single-use, expiring OAuth state and PKCE verifier records.';
comment on table public.audit_logs is 'Append-only security and authentication event log.';
