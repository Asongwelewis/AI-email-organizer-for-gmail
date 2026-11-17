-- Watched folders: the ones someone keeps checking Gmail for. A watched folder sorts first in the
-- Inbox, and new mail in it alerts their devices.

-- A facet combination like a favourite, but always written in one canonical facet order — entity,
-- domain, intent — because a watch is about the mail, not about the arrangement it was set from.
create table public.watched_folders (
  id uuid primary key default gen_random_uuid(),
  connected_google_account_id uuid not null
    references public.connected_google_accounts(id) on delete cascade,
  facet_key text not null check (char_length(facet_key) between 3 and 400),
  created_at timestamptz not null default now(),
  constraint watched_folders_account_key_unique unique (connected_google_account_id, facet_key)
);

alter table public.watched_folders enable row level security;
alter table public.watched_folders force row level security;
revoke all on table public.watched_folders from public, anon, authenticated;

-- When a new-mail notification was found to be in a watched folder and alerted as such. It is set
-- once, by a conditional update, so racing instances alert a watched message once; and it can be
-- set after the notification row, because a watch on an intent can only match once Gemini has
-- decided the intent.
alter table public.notifications add column watched_at timestamptz;
