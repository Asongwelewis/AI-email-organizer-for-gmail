alter table public.automation_runs
  add column last_provider_status integer,
  add column last_provider_code text,
  add column last_provider_request_id text,
  add constraint automation_runs_provider_status_check
    check (last_provider_status is null or last_provider_status between 100 and 599),
  add constraint automation_runs_provider_code_length_check
    check (last_provider_code is null or char_length(last_provider_code) <= 100),
  add constraint automation_runs_provider_request_id_length_check
    check (
      last_provider_request_id is null
      or char_length(last_provider_request_id) <= 200
    );

comment on column public.automation_runs.last_provider_code is
  'Sanitized OpenAI error type/code; never stores provider response text.';
comment on column public.automation_runs.last_provider_request_id is
  'OpenAI request identifier used for support diagnostics; never a credential.';
