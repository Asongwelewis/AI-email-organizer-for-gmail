-- Stage 1: remove the classification feature and the label-discovery review workflow.
-- The discovery engine is preserved, so dynamic_label_candidates and
-- dynamic_label_candidate_messages remain, along with the classification_category enum that
-- automation_message_actions and learned_classification_patterns still use.

drop table if exists public.user_classification_corrections;
drop table if exists public.classification_results;
drop table if exists public.classification_runs;
drop table if exists public.classification_states;
drop table if exists public.label_decisions;
drop table if exists public.label_discovery_runs;
drop table if exists public.label_discovery_states;

-- Only label_decisions used this guard; set_updated_at, validate_dynamic_label_merge, and
-- validate_dynamic_label_association_account are still used by surviving tables.
drop function if exists public.prevent_label_decision_mutation();

drop type if exists public.recommended_action;
drop type if exists public.classification_source;
drop type if exists public.classification_status;
drop type if exists public.classification_run_status;
drop type if exists public.label_candidate_decision;
drop type if exists public.label_discovery_run_status;
