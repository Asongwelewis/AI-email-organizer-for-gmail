-- Automatic onboarding, and the indexes several hundred mailboxes need.

-- Onboarding runs as an activity run like every other long job, so the PWA polls it the same way.
alter type public.activity_run_kind add value if not exists 'ONBOARDING';

-- Where a mailbox is in its first setup. `onboarding_completed_at` is the gate the watcher and the
-- full runs wait behind: until it is set, onboarding owns the mailbox. The stage is what the
-- progress bar names while it is not.
alter table public.connected_google_accounts
  add column onboarding_stage text
    check (onboarding_stage in ('SYNCING', 'LEARNING', 'SORTING', 'DONE')),
  add column onboarding_completed_at timestamptz;

-- Mailboxes that were set up by hand before this existed are already set up: they finished a
-- sync and approved a vocabulary. Everyone else — connected, never sorted — is picked up by the
-- onboarding sweep on the next deploy.
update public.connected_google_accounts account
set onboarding_stage = 'DONE',
    onboarding_completed_at = now()
where exists (
    select 1 from public.gmail_sync_states state
    where state.connected_google_account_id = account.id
      and state.initial_sync_completed_at is not null
  )
  and exists (
    select 1 from public.facet_vocabularies vocabulary
    where vocabulary.connected_google_account_id = account.id
      and vocabulary.status = 'APPROVED'
  );

-- The onboarding sweep asks "connected and not finished" every minute.
create index connected_google_accounts_onboarding_pending_idx
  on public.connected_google_accounts(connected_at)
  where onboarding_completed_at is null and gmail_connected;

-- The Gemini key is shared by every mailbox, so its daily request budget is read as a sum over
-- today's runs for all of them — by start time, across accounts.
create index automation_runs_started_idx on public.automation_runs(started_at);

-- Housekeeping deletes by age.
create index activity_runs_finished_idx on public.activity_runs(finished_at);
create index notifications_created_idx on public.notifications(created_at);
create index gmail_sync_runs_started_idx on public.gmail_sync_runs(started_at);
