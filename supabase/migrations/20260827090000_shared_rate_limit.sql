-- Rate limits that actually hold across instances.
--
-- The limiters used express-rate-limit's default in-memory store while the deployment docs claimed
-- multi-instance capability. Both halves of that were a problem: with two instances every limit is
-- effectively doubled because each keeps its own counter, and a restart clears them entirely — so
-- the cheapest way past an auth limit was to wait for a deploy.
--
-- A row per (key, window). The window start is part of the primary key, so a new window is a new
-- row rather than a read-modify-write of an old one: two instances incrementing the same client at
-- the same moment both land on `on conflict do update`, which is atomic, instead of racing over a
-- value one of them read a moment ago.
create table public.rate_limit_hits (
  -- The limiter's own key: usually a client IP, always opaque to us. Never an email or a user id.
  key text not null check (char_length(key) between 1 and 256),
  -- The floor of the current window. Two columns rather than a range, so the primary key is a
  -- plain btree and expiry is an index scan.
  window_start timestamptz not null,
  window_ms integer not null check (window_ms between 1000 and 86400000),
  hits integer not null default 0 check (hits >= 0),
  expires_at timestamptz not null,
  primary key (key, window_start, window_ms)
);

-- Sweeping expired rows is the only thing that reads by time, and it is what keeps this table from
-- growing without bound. Nothing depends on the sweep being prompt: an expired row is ignored by
-- the increment path regardless, because a new window means a new key.
create index rate_limit_hits_expiry_idx on public.rate_limit_hits(expires_at);

alter table public.rate_limit_hits enable row level security;
alter table public.rate_limit_hits force row level security;
revoke all on table public.rate_limit_hits from public, anon, authenticated;
