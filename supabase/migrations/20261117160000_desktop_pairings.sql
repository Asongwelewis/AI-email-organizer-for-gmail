-- The desktop island's way in.
--
-- The island is a small Windows program showing AMO on the desktop, and Google refuses sign-in
-- inside a desktop program. So it pairs the way a television does: it shows a short code, the
-- person types that code into AMO in their own browser where they are already signed in, and the
-- island's next poll receives a session of its own.
--
-- Nothing here is readable as a secret: both the code and the island's poll secret are stored as
-- SHA-256 hashes. A row lives ten minutes, is approved once and completed once, and housekeeping
-- deletes it a day after it expired.
create table public.desktop_pairings (
  id uuid primary key default gen_random_uuid(),
  -- Only the island that started the pairing knows this; it is what claims the session.
  poll_secret_hash text not null,
  -- What the person types. Not unique: an expired row may hold the same code as a new one.
  user_code_hash text not null,
  -- Set by the signed-in person who typed the code. `on delete cascade`, because deleting an
  -- account removes everything stored about it.
  approved_user_id uuid references public.users(id) on delete cascade,
  approved_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint desktop_pairings_poll_secret_hash_key unique (poll_secret_hash),
  constraint desktop_pairings_approval_check check (
    (approved_user_id is null) = (approved_at is null)
  ),
  constraint desktop_pairings_completion_check check (
    completed_at is null or approved_at is not null
  )
);

create index desktop_pairings_user_code_idx on public.desktop_pairings(user_code_hash);
create index desktop_pairings_expiry_idx on public.desktop_pairings(expires_at);
create index desktop_pairings_approved_user_idx on public.desktop_pairings(approved_user_id);

alter table public.desktop_pairings enable row level security;
alter table public.desktop_pairings force row level security;
revoke all on table public.desktop_pairings from public, anon, authenticated;
