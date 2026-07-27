alter table public.gmail_sync_states
  add column total_gmail_messages integer,
  add column backfill_page_token text,
  add column backfill_history_id text,
  add column backfill_messages_processed integer not null default 0,
  add column backfill_pages_completed integer not null default 0,
  add column backfill_started_at timestamptz,
  add column backfill_checkpointed_at timestamptz,
  add column backfill_listing_completed_at timestamptz,
  add column backfill_completed_at timestamptz;

alter table public.gmail_sync_states
  add constraint gmail_sync_states_total_messages_check
    check (total_gmail_messages is null or total_gmail_messages >= 0),
  add constraint gmail_sync_states_backfill_processed_check
    check (backfill_messages_processed >= 0),
  add constraint gmail_sync_states_backfill_pages_check
    check (backfill_pages_completed >= 0);

with ranked_active_results as (
  select
    id,
    row_number() over (
      partition by connected_google_account_id, gmail_message_id
      order by classified_at desc, id desc
    ) as active_rank
  from public.classification_results
  where status in ('PENDING', 'COMPLETED', 'NEEDS_REVIEW')
)
update public.classification_results as result
set status = 'SUPERSEDED'
from ranked_active_results as ranked
where result.id = ranked.id
  and ranked.active_rank > 1;

drop index if exists public.classification_results_active_version_hash_unique_idx;

create unique index classification_results_active_message_unique_idx
  on public.classification_results(connected_google_account_id, gmail_message_id)
  where status in ('PENDING', 'COMPLETED', 'NEEDS_REVIEW');
