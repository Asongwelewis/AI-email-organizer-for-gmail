-- Classifying mail into facets is its own long-running operation, and until now it had no run kind
-- of its own: driven from a `tsx` script it recorded nothing, and reported over HTTP it would have
-- had to borrow AUTOMATION_FILING and tell the Activity screen it was filing when it was not.
--
-- Additive only. Postgres 12+ allows ALTER TYPE ... ADD VALUE inside a transaction as long as the
-- new value is not used in the same transaction, and nothing here uses it.
alter type public.activity_run_kind add value if not exists 'FACET_CLASSIFICATION';
