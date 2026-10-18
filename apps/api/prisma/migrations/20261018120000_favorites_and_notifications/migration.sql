-- Favourite folders, the new-mail notification feed, and the browser push subscriptions that carry
-- those notifications to the operating system.

-- A folder is a facet combination, so a favourite is one too. `facet_key` is the folder's identity
-- — "entity=netflix|intent=payment-failed" — and the same key names the same mail in any
-- arrangement that has it, which is why it, not a row id, is unique per mailbox. `pivot_order` is
-- the arrangement it was starred in, so opening it lands in the view it came from.
create table public.favorite_folders (
  id uuid primary key default gen_random_uuid(),
  connected_google_account_id uuid not null
    references public.connected_google_accounts(id) on delete cascade,
  facet_key text not null check (char_length(facet_key) between 3 and 400),
  pivot_order text[] not null check (
    cardinality(pivot_order) between 1 and 3
    and pivot_order <@ array['entity', 'domain', 'intent']::text[]
  ),
  created_at timestamptz not null default now(),
  constraint favorite_folders_account_key_unique unique (connected_google_account_id, facet_key)
);

create index favorite_folders_account_created_idx
  on public.favorite_folders(connected_google_account_id, created_at desc);

alter table public.favorite_folders enable row level security;
alter table public.favorite_folders force row level security;
revoke all on table public.favorite_folders from public, anon, authenticated;

-- One row per new message worth telling someone about. It points at the stored message rather than
-- copying its sender and subject, so there is one copy of the metadata and deleting the message —
-- or the account — takes the notification with it.
create type public.notification_kind as enum ('NEW_MAIL');

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  connected_google_account_id uuid not null
    references public.connected_google_accounts(id) on delete cascade,
  kind public.notification_kind not null default 'NEW_MAIL',
  -- Unique: a message is announced once, however many times the watcher looks at it.
  gmail_message_id uuid not null unique
    references public.gmail_message_metadata(id) on delete cascade,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_account_created_idx
  on public.notifications(connected_google_account_id, created_at desc);
-- The unread badge is asked for on every screen.
create index notifications_account_unread_idx
  on public.notifications(connected_google_account_id) where read_at is null;

alter table public.notifications enable row level security;
alter table public.notifications force row level security;
revoke all on table public.notifications from public, anon, authenticated;

-- A browser's push subscription: where the push service will deliver to, and the keys the payload
-- is encrypted with (RFC 8291), so the push service carries it without being able to read it. One
-- per browser per person; the endpoint is the browser's identity.
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  endpoint text not null unique
    check (char_length(endpoint) between 12 and 1000 and endpoint like 'https://%'),
  p256dh text not null check (char_length(p256dh) between 16 and 200),
  auth text not null check (char_length(auth) between 8 and 100),
  user_agent text check (user_agent is null or char_length(user_agent) <= 300),
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  failure_count integer not null default 0 check (failure_count >= 0)
);

create index push_subscriptions_user_idx on public.push_subscriptions(user_id);

alter table public.push_subscriptions enable row level security;
alter table public.push_subscriptions force row level security;
revoke all on table public.push_subscriptions from public, anon, authenticated;
