-- Search that finds the one email.
--
-- Folders are half of findability; the other half is finding a message you can only half remember.
-- With Gmail out of the write path, `label:` is no longer the mechanism — the PWA has to answer
-- "the failed payment from some streaming service" itself, out of the metadata it already stores.
--
-- Full text over subject and sender, and nothing else. There is no body here to search and there
-- never will be: the Gmail boundary is metadata-only, so this index reaches exactly as far as the
-- sync does.
--
-- Two details make it match what a person types:
--
--   `simple` rather than `english`. The vocabulary being searched is brand names, order numbers
--   and subject lines, not prose. Stemming "Coursera" or "Renewal" buys nothing and costs exact
--   matches, and a mailbox is not all one language.
--
--   `translate` on the address. `billing@netflix.com` is one `email` token to the parser, so a
--   search for "netflix" would not match it. Splitting on the punctuation makes the brand its own
--   lexeme. The query side applies the identical transform, so typing the whole address still
--   works — it simply becomes three words that must all appear.
--
-- Read-only: an index, and not a column. Nothing here changes what is stored or what is sent.
create index if not exists gmail_messages_account_search_idx
  on public.gmail_message_metadata
  using gin (
    to_tsvector(
      'simple',
      coalesce(subject, '') || ' ' ||
      coalesce(sender_name, '') || ' ' ||
      translate(coalesce(sender_email, ''), '@._-', '    ')
    )
  );
