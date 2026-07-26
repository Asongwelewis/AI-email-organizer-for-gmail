alter table public.users
  add column tutorial_completed_at timestamptz;

-- Existing accounts already know the pre-tutorial product. Only accounts created
-- after this migration should receive the first-run scenario.
update public.users
set tutorial_completed_at = now()
where tutorial_completed_at is null;
