-- Stage 3: the automation classifier is Google Gemini, not OpenAI.
-- The stored names described the vendor rather than the role, so swapping providers would have
-- left every historical row and counter misleading. These renames are provider-neutral and
-- preserve all existing data; no row is rewritten and no value is dropped.

alter type public.automation_classification_source rename value 'OPENAI' to 'AI';

alter table public.automation_runs
  rename column openai_classified_count to ai_classified_count;

-- Renaming a column leaves its inline check constraint under the generated old name.
alter table public.automation_runs
  rename constraint automation_runs_openai_classified_count_check
  to automation_runs_ai_classified_count_check;

-- The recovery columns are provider-agnostic; only their comments named OpenAI.
comment on column public.automation_runs.last_provider_code is
  'Sanitized provider error status/code; never stores provider response text.';
comment on column public.automation_runs.last_provider_request_id is
  'Provider request identifier used for support diagnostics; never a credential.';
