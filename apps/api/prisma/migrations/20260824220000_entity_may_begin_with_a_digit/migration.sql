-- An entity may begin with a digit, because brands do.
--
-- The shape check was copied from the one that guards `domain` and `intent`, where a leading
-- letter is guaranteed: those values come from a closed vocabulary a human approved. `entity` is
-- not like that. It is derived from whatever domain actually sent the mail, and 1password.com,
-- 1xbet.com and 360safe.com are ordinary brands, not malformed input.
--
-- The consequence was worse than a rejected row. Classification writes a batch at a time, so one
-- message from 1xbet.com failed the constraint and took the twenty-four messages beside it down
-- with it — and since every retry re-read the same unclassified message first, the run made no
-- progress at all while still renewing its lease. A mailbox stopped classifying at 67% because
-- two of its senders start with a digit.
--
-- domain and intent keep the strict rule: a value that does not begin with a letter is not in the
-- approved vocabulary, and there the constraint is doing exactly what it should.

alter table public.message_facets
  drop constraint message_facets_entity_shape_check,
  add constraint message_facets_entity_shape_check check (
    entity is null or entity ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  );
