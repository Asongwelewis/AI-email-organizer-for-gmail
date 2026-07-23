-- Complete the Stage 2 lookup/cleanup indexes and make the backend-only
-- privilege boundary explicit. The dedicated Prisma role is provisioned
-- separately because login-role passwords must never be committed.

create index oauth_states_used_at_idx on public.oauth_states(used_at);
create index oauth_states_initiating_session_idx on public.oauth_states(initiating_session_id);
create index sessions_revoked_at_idx on public.sessions(revoked_at);
create index connected_google_accounts_access_token_expires_at_idx
  on public.connected_google_accounts(access_token_expires_at);

revoke all on table public.users from public, anon, authenticated;
revoke all on table public.sessions from public, anon, authenticated;
revoke all on table public.connected_google_accounts from public, anon, authenticated;
revoke all on table public.oauth_states from public, anon, authenticated;
revoke all on table public.audit_logs from public, anon, authenticated;
