-- Semantic taxonomy: one planned 3-level tree replaces per-sender candidate scoring.
--
-- The heuristic engine produced one bucket per sending domain, which Gmail's own `from:` search
-- already answers. The valuable folders cross senders ("Job hunt / Applications sent" spans
-- LinkedIn, Greenhouse, Handshake), so a single model call now designs the whole tree and the
-- human approves it before anything is created in Gmail.
--
-- Gmail nesting is cosmetic: `A/B` is one label whose name contains a slash, and applying it does
-- not apply `A`. The tree therefore lives here, and only the leaf's full path is created in Gmail.

-- 1. user_labels becomes a tree ------------------------------------------------------------------

alter table public.user_labels
  add column parent_id uuid references public.user_labels(id) on delete cascade,
  add column depth integer not null default 1 check (depth between 1 and 3),
  add column rationale text check (rationale is null or char_length(rationale) <= 500);

-- A three-level path plus the MailMind prefix outgrows the flat-label limit.
alter table public.user_labels
  drop constraint user_labels_full_path_check,
  add constraint user_labels_full_path_check check (
    char_length(full_path) between 1 and 225 and full_path like 'MailMind/%'
  ),
  add constraint user_labels_root_parent_check check ((depth = 1) = (parent_id is null));

create index user_labels_parent_idx on public.user_labels(parent_id);
create index user_labels_account_depth_idx
  on public.user_labels(connected_google_account_id, depth);

-- Depth, ownership, and path composition are invariants Prisma cannot express. Enforcing them here
-- means a bad write fails at the database rather than producing a tree that cannot be rendered.
create function public.validate_user_label_tree()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  parent_depth integer;
  parent_path text;
  parent_account uuid;
begin
  if new.parent_id is null then
    if new.full_path <> 'MailMind/' || new.leaf_name then
      raise exception 'USER_LABEL_PATH_MISMATCH';
    end if;
    return new;
  end if;

  select depth, full_path, connected_google_account_id
    into parent_depth, parent_path, parent_account
    from public.user_labels
   where id = new.parent_id;

  if parent_depth is null then
    raise exception 'USER_LABEL_PARENT_NOT_FOUND';
  end if;
  if parent_account <> new.connected_google_account_id then
    raise exception 'USER_LABEL_PARENT_ACCOUNT_MISMATCH';
  end if;
  if parent_depth <> new.depth - 1 then
    raise exception 'USER_LABEL_DEPTH_MISMATCH';
  end if;
  if new.full_path <> parent_path || '/' || new.leaf_name then
    raise exception 'USER_LABEL_PATH_MISMATCH';
  end if;
  return new;
end;
$$;

create trigger user_labels_validate_tree
before insert or update on public.user_labels
for each row execute function public.validate_user_label_tree();

-- 2. learned_classification_patterns becomes the routing-rule table ------------------------------
-- Planner rules and rules learned from applied mail share one table so the executor has a single
-- rules-before-AI lookup. A sender domain is no longer the only way to route.

create type public.routing_rule_kind as enum ('SENDER_DOMAIN', 'SENDER_ADDRESS', 'SUBJECT_CONTAINS');
create type public.routing_rule_source as enum ('PLANNER', 'LEARNED');

alter table public.learned_classification_patterns
  add column rule_kind public.routing_rule_kind not null default 'SENDER_DOMAIN',
  add column match_value text,
  add column rule_source public.routing_rule_source not null default 'LEARNED',
  add column user_label_id uuid references public.user_labels(id) on delete cascade,
  add column priority integer not null default 100 check (priority between 0 and 1000);

update public.learned_classification_patterns set match_value = sender_domain;

alter table public.learned_classification_patterns
  alter column match_value set not null,
  add constraint learned_patterns_match_value_length_check
    check (char_length(match_value) between 1 and 320),
  drop constraint learned_patterns_account_sender_unique_idx,
  drop column sender_domain;

alter table public.learned_classification_patterns
  add constraint learned_patterns_account_rule_unique_idx
    unique (connected_google_account_id, rule_kind, match_value);

create index learned_patterns_account_label_idx
  on public.learned_classification_patterns(user_label_id);

-- 3. The candidate-scoring tables have no remaining consumer ------------------------------------
-- Both held regenerated-on-every-run proposals from the heuristic engine, never user data.

drop table public.dynamic_label_candidate_messages;
drop table public.dynamic_label_candidates;
drop type public.dynamic_label_candidate_type;
drop type public.dynamic_label_candidate_status;

-- 4. The proposed tree awaiting human approval ---------------------------------------------------

create type public.taxonomy_plan_status as enum ('PENDING', 'APPROVED', 'SUPERSEDED');
create type public.taxonomy_node_kind as enum ('CATEGORY', 'TOPIC', 'STATE');

create table public.taxonomy_plans (
  id uuid primary key default gen_random_uuid(),
  connected_google_account_id uuid not null
    references public.connected_google_accounts(id) on delete cascade,
  status public.taxonomy_plan_status not null default 'PENDING',
  model text not null check (char_length(model) between 1 and 200),
  prompt_version text not null check (char_length(prompt_version) between 1 and 80),
  sampled_message_count integer not null check (sampled_message_count >= 0),
  analyzed_message_count integer not null check (analyzed_message_count >= 0),
  leaf_count integer not null default 0 check (leaf_count >= 0),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  estimated_cost_microusd integer not null default 0 check (estimated_cost_microusd >= 0),
  warnings text[] not null default '{}',
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.taxonomy_plan_nodes (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.taxonomy_plans(id) on delete cascade,
  parent_id uuid references public.taxonomy_plan_nodes(id) on delete cascade,
  depth integer not null check (depth between 1 and 3),
  kind public.taxonomy_node_kind not null,
  name text not null check (char_length(name) between 1 and 60),
  full_path text not null check (
    char_length(full_path) between 1 and 225 and full_path like 'MailMind/%'
  ),
  normalized_name text not null check (char_length(normalized_name) between 1 and 120),
  rationale text not null check (char_length(rationale) between 1 and 500),
  estimated_message_count integer not null check (estimated_message_count >= 0),
  matched_message_count integer not null default 0 check (matched_message_count >= 0),
  is_leaf boolean not null default true,
  position integer not null default 0 check (position >= 0),
  created_at timestamptz not null default now(),
  constraint taxonomy_plan_nodes_root_parent_check check ((depth = 1) = (parent_id is null)),
  constraint taxonomy_plan_nodes_path_unique_idx unique (plan_id, full_path)
);

create table public.taxonomy_plan_node_rules (
  id uuid primary key default gen_random_uuid(),
  node_id uuid not null references public.taxonomy_plan_nodes(id) on delete cascade,
  rule_kind public.routing_rule_kind not null,
  match_value text not null check (char_length(match_value) between 1 and 320),
  matched_message_count integer not null default 0 check (matched_message_count >= 0),
  created_at timestamptz not null default now(),
  constraint taxonomy_plan_node_rules_unique_idx unique (node_id, rule_kind, match_value)
);

create index taxonomy_plans_account_status_idx
  on public.taxonomy_plans(connected_google_account_id, status, created_at desc);
create index taxonomy_plan_nodes_plan_idx on public.taxonomy_plan_nodes(plan_id, depth, position);
create index taxonomy_plan_nodes_parent_idx on public.taxonomy_plan_nodes(parent_id);
create index taxonomy_plan_node_rules_node_idx on public.taxonomy_plan_node_rules(node_id);

-- Only one plan may await review per account: a new proposal supersedes the previous one.
create unique index taxonomy_plans_account_pending_unique_idx
  on public.taxonomy_plans(connected_google_account_id)
  where status = 'PENDING';

create trigger taxonomy_plans_set_updated_at
before update on public.taxonomy_plans
for each row execute function public.set_updated_at();

alter table public.taxonomy_plans enable row level security;
alter table public.taxonomy_plans force row level security;
alter table public.taxonomy_plan_nodes enable row level security;
alter table public.taxonomy_plan_nodes force row level security;
alter table public.taxonomy_plan_node_rules enable row level security;
alter table public.taxonomy_plan_node_rules force row level security;

revoke all on table public.taxonomy_plans from public, anon, authenticated;
revoke all on table public.taxonomy_plan_nodes from public, anon, authenticated;
revoke all on table public.taxonomy_plan_node_rules from public, anon, authenticated;
revoke all on function public.validate_user_label_tree() from public, anon, authenticated;
