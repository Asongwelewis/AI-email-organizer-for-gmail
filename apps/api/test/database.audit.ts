import { prisma } from '../src/database/prisma.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Database audit failed: ${message}`);
}

const applicationTables = [
  'audit_logs',
  'connected_google_accounts',
  'oauth_states',
  'sessions',
  'users',
];

const requiredIndexes = [
  'audit_logs_action_idx',
  'audit_logs_created_at_idx',
  'audit_logs_user_id_idx',
  'connected_google_accounts_access_token_expires_at_idx',
  'connected_google_accounts_status_idx',
  'connected_google_accounts_user_id_idx',
  'oauth_states_expiry_idx',
  'oauth_states_initiating_session_idx',
  'oauth_states_initiating_user_idx',
  'oauth_states_purpose_idx',
  'oauth_states_state_hash_unique_idx',
  'oauth_states_used_at_idx',
  'sessions_expires_at_idx',
  'sessions_revoked_at_idx',
  'sessions_token_hash_unique_idx',
  'sessions_user_id_idx',
  'users_google_subject_unique_idx',
  'users_normalized_email_unique_idx',
  'users_status_idx',
];

try {
  await prisma.$connect();

  const tables = await prisma.$queryRaw<
    Array<{ table_name: string; rls_enabled: boolean; rls_forced: boolean }>
  >`
    select c.relname as table_name,
           c.relrowsecurity as rls_enabled,
           c.relforcerowsecurity as rls_forced
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('users', 'connected_google_accounts', 'sessions', 'oauth_states', 'audit_logs')
    order by c.relname
  `;
  assert(
    JSON.stringify(tables.map((table) => table.table_name)) === JSON.stringify(applicationTables),
    'the five application tables must exist',
  );
  assert(
    tables.every((table) => table.rls_enabled && table.rls_forced),
    'RLS must be enabled and forced on all application tables',
  );

  const role = await prisma.$queryRaw<Array<{ role_name: string; bypasses_rls: boolean }>>`
    select current_user as role_name, rolbypassrls as bypasses_rls
    from pg_catalog.pg_roles
    where rolname = current_user
  `;
  assert(role[0]?.role_name === 'prisma', 'the configured database role must be prisma');
  assert(role[0]?.bypasses_rls, 'the trusted Prisma backend role must deliberately bypass RLS');

  const publicPrivileges = await prisma.$queryRaw<
    Array<{ role_name: string; privilege_count: bigint }>
  >`
    select roles.role_name,
           count(*) filter (
             where has_table_privilege(
               roles.role_name,
               format('public.%I', tables.table_name),
               privileges.privilege
             )
           ) as privilege_count
    from unnest(array['public', 'anon', 'authenticated']) as roles(role_name)
    cross join unnest(array['users', 'connected_google_accounts', 'sessions', 'oauth_states', 'audit_logs']) as tables(table_name)
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as privileges(privilege)
    group by roles.role_name
    order by roles.role_name
  `;
  assert(
    publicPrivileges.every((entry) => entry.privilege_count === 0n),
    'PUBLIC, anon, and authenticated must have no application-table DML privileges',
  );

  const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
    select indexname
    from pg_catalog.pg_indexes
    where schemaname = 'public'
      and indexname in (
        'audit_logs_action_idx',
        'audit_logs_created_at_idx',
        'audit_logs_user_id_idx',
        'connected_google_accounts_access_token_expires_at_idx',
        'connected_google_accounts_status_idx',
        'connected_google_accounts_user_id_idx',
        'oauth_states_expiry_idx',
        'oauth_states_initiating_session_idx',
        'oauth_states_initiating_user_idx',
        'oauth_states_purpose_idx',
        'oauth_states_state_hash_unique_idx',
        'oauth_states_used_at_idx',
        'sessions_expires_at_idx',
        'sessions_revoked_at_idx',
        'sessions_token_hash_unique_idx',
        'sessions_user_id_idx',
        'users_google_subject_unique_idx',
        'users_normalized_email_unique_idx',
        'users_status_idx'
      )
    order by indexname
  `;
  assert(
    JSON.stringify(indexes.map((index) => index.indexname)) === JSON.stringify(requiredIndexes),
    'all required unique and lookup indexes must exist',
  );

  const triggers = await prisma.$queryRaw<Array<{ trigger_name: string }>>`
    select tgname as trigger_name
    from pg_catalog.pg_trigger
    where not tgisinternal
      and tgrelid in ('public.users'::regclass, 'public.connected_google_accounts'::regclass)
    order by tgname
  `;
  assert(
    JSON.stringify(triggers.map((trigger) => trigger.trigger_name)) ===
      JSON.stringify(['connected_google_accounts_set_updated_at', 'users_set_updated_at']),
    'both updated_at triggers must exist',
  );

  const catalog = await prisma.$queryRaw<
    Array<{
      enum_count: bigint;
      foreign_key_count: bigint;
      citext_count: bigint;
      migration_count: bigint;
      failed_migration_count: bigint;
      test_artifact_count: bigint;
      uuid_available: boolean;
    }>
  >`
    select
      (select count(*) from pg_catalog.pg_type t
       join pg_catalog.pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'public'
         and t.typname in ('audit_result', 'google_connection_status', 'oauth_purpose', 'user_status')) as enum_count,
      (select count(*) from pg_catalog.pg_constraint
       where contype = 'f'
         and connamespace = 'public'::regnamespace) as foreign_key_count,
      (select count(*) from pg_catalog.pg_extension where extname = 'citext') as citext_count,
      (select count(*) from public._prisma_migrations
       where finished_at is not null and rolled_back_at is null) as migration_count,
      (select count(*) from public._prisma_migrations
       where finished_at is null and rolled_back_at is null) as failed_migration_count,
      (
        (select count(*) from public.users
         where google_subject like 'subject-%'
            or email in ('first@example.com', 'changed@example.com', 'rotate@example.com', 'connections@example.com'))
        +
        (select count(*) from public.connected_google_accounts
         where google_subject in ('first-gmail-subject', 'second-gmail-subject'))
      ) as test_artifact_count,
      (select gen_random_uuid() is not null) as uuid_available
  `;
  const summary = catalog[0];
  assert(summary?.enum_count === 4n, 'all four enum types must exist');
  assert(summary.foreign_key_count === 6n, 'all six foreign keys must exist');
  assert(summary.citext_count === 0n, 'citext must not be installed as a MailMind dependency');
  assert(summary.migration_count === 2n, 'exactly two intended Prisma migrations must be applied');
  assert(summary.failed_migration_count === 0n, 'no failed Prisma migration may remain');
  assert(summary.test_artifact_count === 0n, 'no known integration-test records may remain');
  assert(summary.uuid_available, 'gen_random_uuid() must be available');

  console.log(
    JSON.stringify({
      status: 'passed',
      role: 'prisma',
      migrations: Number(summary.migration_count),
      protectedTables: tables.length,
      requiredIndexes: indexes.length,
      triggers: triggers.length,
      foreignKeys: Number(summary.foreign_key_count),
      enums: Number(summary.enum_count),
    }),
  );
} finally {
  await prisma.$disconnect();
}
