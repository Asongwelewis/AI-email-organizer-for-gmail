-- Recording "no approved folder fits" is a decision, not a failure.
--
-- Automation files a message into exactly one approved leaf or records NONE and leaves it in the
-- inbox. The NONE branch had no path to write, so it wrote an empty string, which label_path's
-- check rejects with 23514. The insert threw, the surrounding catch counted the whole batch as
-- failed and broke out of the run, and nothing was recorded. The documented outcome was the one
-- outcome this table could not store, so a mailbox whose mail genuinely fits nowhere could not be
-- processed at all.

alter table public.automation_message_actions
  alter column label_path drop not null,
  drop constraint automation_message_actions_label_path_check,
  add constraint automation_message_actions_label_path_check check (
    label_path is null
      or (char_length(label_path) between 1 and 225 and label_path like 'MailMind/%')
  ),
  -- A filing decision names a folder and carries its full path; a NONE decision has neither.
  -- 'NONE' is the sentinel the classifier returns, and it is never a folder name.
  add constraint automation_actions_no_label_path_check check (
    (label_name = 'NONE') = (label_path is null)
  );
