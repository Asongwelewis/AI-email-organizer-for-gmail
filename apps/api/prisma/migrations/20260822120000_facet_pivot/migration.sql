-- Pivoting facets into folders.
--
-- Facets are orthogonal, so the folder tree is a VIEW of them rather than the thing itself: order
-- the facets one way and you get Netflix > Payment failed, order them another and you get
-- Finance > Payment failed > Netflix. Both describe the same mail. Exactly one ordering is
-- materialised into Gmail, because a message can carry one MailMind label and no more; every other
-- ordering is computed on read from message_facets and never touches Gmail at all.

-- Every element has to be a real facet, and the same facet must not appear twice: a pivot that
-- repeats a facet would nest a folder inside itself. A check constraint may not contain a subquery,
-- and there is no subquery-free way to say "these array elements are distinct" — so the test lives
-- in an immutable function, which a constraint may call.
create function public.is_valid_facet_pivot(pivot text[])
returns boolean
language sql
immutable
set search_path = pg_catalog, public
as $$
  select pivot is not null
     and cardinality(pivot) between 1 and 3
     and pivot <@ array['entity', 'domain', 'intent']
     and cardinality(pivot) = cardinality(array(select distinct unnest(pivot)));
$$;

create table public.facet_pivot_settings (
  id uuid primary key default gen_random_uuid(),
  connected_google_account_id uuid not null unique
    references public.connected_google_accounts(id) on delete cascade,
  -- Ordered. The first facet is the top level of the tree. Stored as an array rather than three
  -- columns because the ORDER is the whole configuration.
  canonical_pivot text[] not null default array['entity', 'intent'],
  -- Below this a folder is clutter, so its mail files one level up instead. Configurable because
  -- the right number depends on how much mail a mailbox gets, not on anything we can know here.
  min_messages integer not null default 5 check (min_messages between 1 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint facet_pivot_settings_facets_check check (public.is_valid_facet_pivot(canonical_pivot))
);

create trigger facet_pivot_settings_set_updated_at
before update on public.facet_pivot_settings
for each row execute function public.set_updated_at();

alter table public.facet_pivot_settings enable row level security;
alter table public.facet_pivot_settings force row level security;
revoke all on table public.facet_pivot_settings from public, anon, authenticated;

-- Which facet combination a folder holds, as "entity=netflix|intent=payment-failed".
--
-- Matching a materialised folder back to its combination by NAME would break the moment a display
-- name changed, and matching by path would break the moment the pivot order changed. This column
-- is the identity of the folder; the path is only how it is spelled. Null on the folders the tree
-- planner created before facets existed — those keep their rows and their Gmail labels untouched.
alter table public.user_labels
  add column facet_key text check (facet_key is null or char_length(facet_key) between 1 and 200);

create unique index user_labels_account_facet_key_unique_idx
  on public.user_labels(connected_google_account_id, facet_key)
  where facet_key is not null;

-- Folder names become unique among SIBLINGS instead of across the whole account.
--
-- The old rule existed because automation's vocabulary was the leaf NAME: the model answered with
-- "Rejected" and the name had to identify one folder. A pivot's vocabulary is the facet pair, and
-- a pivot repeats its lower levels by construction — Netflix > Payment failed and Coursera >
-- Payment failed are two different folders that must both exist. Gmail's own requirement is that
-- the full path be unique, and user_labels_account_path_unique_idx already enforces exactly that.
--
-- parent_id is null for a root, and null is distinct from null in a unique index, so two roots of
-- the same name would slip through. coalesce to a fixed uuid closes that.
drop index if exists public.user_labels_account_normalized_unique_idx;

create unique index user_labels_account_sibling_name_unique_idx
  on public.user_labels(
    connected_google_account_id,
    coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    normalized_name
  );
