-- A way for someone who was handed the link to say something back.
--
-- Until now the only route to the person running this deployment was a mailto on the support page,
-- and that address is still the placeholder in `apps/web/src/pages/legal-contact.ts` — so the app
-- could be shared with somebody who then had no working way to report that it was broken.
--
-- This is the only table in the schema an unauthenticated request can write to. That shapes it:
-- it holds what was typed and nothing that was collected. No IP address, no user agent, no
-- referrer, no session id. `page` is a route and never a query string, because ours carry facet
-- values, search phrases and message ids.
create type public.feedback_kind as enum ('PROBLEM', 'IDEA', 'PRAISE', 'OTHER');

create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  kind public.feedback_kind not null default 'OTHER',
  -- The bounds are enforced again in Zod at the edge. Both, because the edge is not the only way
  -- in: a script, a migration or a future endpoint reaches the table without passing the schema.
  message text not null check (char_length(message) between 10 and 4000),
  -- Null is a real answer here: they did not want to be written back to.
  contact text check (contact is null or char_length(contact) between 3 and 320),
  page text check (page is null or char_length(page) <= 120),
  -- Null for a visitor, which is the ordinary case. `on delete cascade` rather than `set null`
  -- because the data-deletion page promises that deleting an account removes everything stored
  -- about you, and a signed-in person's feedback — with the contact address they chose to leave —
  -- is stored about them.
  user_id uuid references public.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Newest first is the only way anybody reads this table.
create index feedback_created_at_idx on public.feedback(created_at desc);

alter table public.feedback enable row level security;
alter table public.feedback force row level security;
revoke all on table public.feedback from public, anon, authenticated;
