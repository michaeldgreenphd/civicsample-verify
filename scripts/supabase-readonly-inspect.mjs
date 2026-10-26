// Read-only inspection of the approved Supabase staging project before a schema change.
//
//   node scripts/supabase-readonly-inspect.mjs --config /abs/private/supabase-admin.json [--out /abs/private/report.json]
//
// Every query runs inside one read-only REPEATABLE READ transaction, one snapshot (PostgreSQL refuses any write in
// it) and the block is rolled back. Only aggregates are reported: schema markers, counts by
// category, role and state, privilege sets and extension placement. No e-mail address, name,
// token, password, answer text or connection detail is printed. The destination is validated as
// the approved staging project, and TLS is always verified.
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readAdminConfig,
  SupabaseIdentityError,
  validateDatabaseDestination,
} from './supabase-identity-tools.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Statements this tool may send: reads, and the read-only transaction around them. */
export const READ_ONLY_STATEMENT =
  /^\s*(select|with|begin transaction isolation level repeatable read read only|set local statement_timeout|rollback)\b/i;

const regclass = (name) => `select to_regclass('${name}') is not null as present`;
/** The inspection, written against `query(sql)`; returns aggregates only. */
export async function inspectWith(query) {
  const q = async (sql) => {
    if (!READ_ONLY_STATEMENT.test(sql)) throw new Error('refused: not a read-only statement');
    return (await query(sql)).rows;
  };
  const present = async (name) => (await q(regclass(name)))[0].present === true;
  const count = async (sql) => Number((await q(sql))[0]?.n ?? 0);
  const report = { readOnly: true };
  await q('begin transaction isolation level repeatable read read only');
  try {
    await q("set local statement_timeout = '15s'");
    const server = (
      await q(
        "select current_setting('server_version_num')::int as version_num, pg_database_size(current_database())::bigint as bytes, current_setting('transaction_read_only') as read_only",
      )
    )[0];
    report.server = {
      versionNum: Number(server.version_num),
      databaseBytes: Number(server.bytes),
      transactionReadOnly: server.read_only,
    };
    report.extensions = await q(
      "select e.extname as name, n.nspname as schema, e.extversion as version from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname in ('pgcrypto', 'pg_graphql', 'pgjwt', 'uuid-ossp') order by 1",
    );
    // A newly created project has no application schema. Inspect its catalogs rather than
    // querying nonexistent tables or treating a missing version marker as proof of emptiness.
    if (!(await present('public.app_schema_version'))) {
      report.schemaVersions = [];
      const userObjects = await count(`
        select count(*)::int as n from (
          select 'pg_class'::regclass as classid, c.oid as objid
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
          union all
          select 'pg_proc'::regclass, p.oid
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public', 'private')
          union all
          select 'pg_type'::regclass, t.oid
          from pg_type t join pg_namespace n on n.oid = t.typnamespace
          where n.nspname in ('public', 'private') and (
            t.typtype in ('d', 'e', 'r', 'm') or (
              t.typtype = 'c' and exists (
                select 1 from pg_class c where c.oid = t.typrelid and c.relkind = 'c'
              )
            )
          )
        ) objects where not exists (
          select 1 from pg_depend d where d.classid = objects.classid
          and d.objid = objects.objid and d.deptype = 'e'
        )`);
      report.bootstrap = {
        state: userObjects === 0 ? 'NO_APPLICATION_OBJECTS' : 'UNVERSIONED_OBJECTS_PRESENT',
        userObjects,
        authUsers: (await present('auth.users'))
          ? await count('select count(*)::int as n from auth.users')
          : null,
        storageObjects: (await present('storage.objects'))
          ? await count('select count(*)::int as n from storage.objects')
          : null,
        note: 'Read-only observation, not authorization to initialize or replace anything.',
      };
      return report;
    }
    report.schemaVersions = (
      await q('select version from public.app_schema_version order by applied_at')
    ).map((r) => r.version);
    report.objects = {};
    for (const t of [
      'public.account_locks',
      'public.mc_campaign',
      'public.mu7_design',
      'public.mu7_gate_requirements',
      'public.tlv5_cases',
      'public.design_activation_v4',
    ])
      report.objects[t] = await present(t);
    // Mapping-confirmation (the existing synthetic pilot): state and counts only.
    if (report.objects['public.mc_campaign']) {
      report.mappingConfirmation = {
        campaign: await q(
          'select phase, condition_set_status, (select count(*) from public.mc_campaign_events)::int as events from public.mc_campaign',
        ),
        casesByCategory: await q(
          'select record_category, count(*)::int as n from public.mc_cases group by 1 order by 1',
        ),
        assignments: await count('select count(*)::int as n from public.mc_assignments'),
        responses: await count('select count(*)::int as n from public.mc_responses'),
        adjudications: await count('select count(*)::int as n from public.mc_adjudications'),
        exports: await count('select count(*)::int as n from public.mc_exports'),
        eventTypes: (
          await q('select event_type from public.mc_campaign_events order by event_seq')
        ).map((r) => r.event_type),
      };
    }
    // Earlier designs: whatever would conflict with recording a v7 design (MU7-G02) or with the
    // proposed coexistence guard.
    report.otherDesigns = {
      tlv5CasesByMode: report.objects['public.tlv5_cases']
        ? await q('select mode, count(*)::int as n from public.tlv5_cases group by 1 order by 1')
        : null,
      tlv5Activations: (await present('public.tlv5_activation'))
        ? await count('select count(*)::int as n from public.tlv5_activation')
        : null,
      v4Activations: report.objects['public.design_activation_v4']
        ? await count('select count(*)::int as n from public.design_activation_v4')
        : null,
      v2CasesByMode: await q(
        'select mode, count(*)::int as n from public.cases group by 1 order by 1',
      ),
      v2PhaseEvents: await q(
        'select event_type, count(*)::int as n from public.review_phase_events group by 1 order by 1',
      ),
      v7DesignRecorded: report.objects['public.mu7_design']
        ? await count('select count(*)::int as n from public.mu7_design')
        : null,
    };
    // Accounts: counts by role and state only.
    report.accounts = {
      appUsers: await q(
        'select role, is_active, is_pilot_test_account, count(*)::int as n from public.users group by 1, 2, 3 order by 1, 2, 3',
      ),
      linkedToAuth: await count(
        'select count(*)::int as n from public.users u where u.auth_uid is not null',
      ),
      activeLocks: report.objects['public.account_locks']
        ? await count(
            'select count(*)::int as n from public.account_locks where released_at is null',
          )
        : null,
      reviewersByScope: await q(
        'select mode_scope, (withdrawn_at is null) as active, count(*)::int as n from public.reviewers group by 1, 2 order by 1, 2',
      ),
      authUsers: await count('select count(*)::int as n from auth.users'),
      verifiedFactorsByRole: await q(
        "select coalesce(u.role, 'UNLINKED') as role, f.factor_type, count(*)::int as n from auth.mfa_factors f left join public.users u on u.auth_uid = f.user_id where f.status = 'verified' group by 1, 2 order by 1, 2",
      ),
      unverifiedFactors: await count(
        "select count(*)::int as n from auth.mfa_factors where status <> 'verified'",
      ),
    };
    // Privileges of the service-role key on application tables (PR #7 review finding).
    report.serviceRolePrivileges = await q(
      "with g as (select table_name, string_agg(privilege_type, ',' order by privilege_type) as privileges from information_schema.role_table_grants where grantee = 'service_role' and table_schema = 'public' group by table_name) select privileges, count(*)::int as tables from g group by 1 order by 1",
    );
    report.publicTables = await count(
      "select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p')",
    );
    report.defaultPrivileges = await q(
      "select pg_get_userbyid(d.defaclrole) as owner, d.defaclobjtype as object_type, array_to_string(d.defaclacl, ' ') as acl from pg_default_acl d where d.defaclnamespace = 'public'::regnamespace order by 1, 2",
    );
    // Review design v7, once its migrations are applied: counts and states only.
    if (report.objects['public.mu7_design']) {
      report.v7 = {
        design: await count('select count(*)::int as n from public.mu7_design'),
        unitsByMode: await q(
          'select mode, count(*)::int as n from public.mu7_units group by 1 order by 1',
        ),
        trainingUnits: await count('select count(*)::int as n from public.mu7_training_units'),
        queueByMode: await q(
          'select mode, count(*)::int as n from public.mu7_queue group by 1 order by 1',
        ),
        judgmentsByMode: await q(
          'select mode, count(*)::int as n from public.mu7_judgments group by 1 order by 1',
        ),
        adjudications: await count('select count(*)::int as n from public.mu7_adjudications'),
        referenceLocks: await q(
          'select mode, n_units_locked from public.mu7_reference_locks order by 1',
        ),
        exports: await q(
          'select mode, manifest_sha256, app_git_sha from public.mu7_exports order by created_at',
        ),
        phaseEvents: (
          await q('select event_type from public.mu7_phase_events order by event_seq')
        ).map((r) => r.event_type),
        freezes: await count('select count(*)::int as n from public.mu7_freeze'),
        gateApprovals: await q(
          'select gate_id, evidence_reference from public.mu7_gate_approvals order by 1',
        ),
        gateRequirements: report.objects['public.mu7_gate_requirements']
          ? await q(
              'select distinct on (gate_id) gate_id, requirement_version, requirement_status from public.mu7_gate_requirements order by gate_id, requirement_version desc',
            )
          : null,
      };
    }
    report.settings = await q(
      "select setting_key, setting_value from public.app_settings where setting_key like 'require%' order by 1",
    );
    report.auditRows = await count('select count(*)::int as n from public.audit_log');
  } finally {
    await q('rollback');
  }
  return report;
}

function readPrivateCa(path) {
  const real = realpathSync(path);
  const info = statSync(real);
  if (!info.isFile() || (info.mode & 0o077) !== 0)
    throw new SupabaseIdentityError(
      'DATABASE_CA_CERT',
      'The CA file must be owner-only (chmod 600).',
    );
  for (let dir = dirname(real); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git')))
      throw new SupabaseIdentityError(
        'DATABASE_CA_CERT',
        'The CA file must live outside every repository.',
      );
    if (dirname(dir) === dir) break;
  }
  return readFileSync(real, 'utf8');
}

async function main(argv) {
  const at = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const configPath = at('--config') ?? process.env.VERIFY_SUPABASE_ADMIN_CONFIG;
  if (!configPath) {
    console.log(JSON.stringify({ status: 'BLOCKED', reason: 'PRIVATE_ADMIN_CONFIG_UNAVAILABLE' }));
    return 2;
  }
  const config = readAdminConfig(configPath, root);
  if (!config.databaseUrl)
    throw new SupabaseIdentityError(
      'DATABASE_URL',
      'The inspection needs databaseUrl in the private configuration.',
    );
  const destination = validateDatabaseDestination(
    config.databaseUrl,
    config.project.stagingProjectRef,
  );
  const { Client } = await import('pg');
  const ssl = { rejectUnauthorized: true };
  if (config.databaseCaCertPath) ssl.ca = readPrivateCa(config.databaseCaCertPath);
  const db = new Client({ connectionString: config.databaseUrl, ssl });
  await db.connect();
  let report;
  try {
    report = {
      status: 'INSPECTED_READ_ONLY',
      projectRef: config.project.stagingProjectRef,
      destinationMode: destination.mode,
      inspectedAt: new Date().toISOString(),
      mutationsPerformed: false,
      ...(await inspectWith((sql) => db.query(sql))),
    };
  } finally {
    await db.end();
  }
  const out = at('--out');
  if (out) {
    if (!isAbsolute(out))
      throw new SupabaseIdentityError('USAGE', '--out must be an absolute private path.');
    writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(
        JSON.stringify({
          status: 'FAILED',
          error: error?.code ?? 'ERROR',
          message: String(error?.message ?? '').slice(0, 200),
        }),
      );
      process.exit(1);
    },
  );
