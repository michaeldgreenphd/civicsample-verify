import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Client } from 'pg';
import {
  computeV4PredictionFileSha256FromDb,
  exportV4SyntheticBundleFromDb,
  verifyV4DatabaseIntegrity,
  type V4DbQueryable,
} from '../src/lib/formal-export';

const ATT = 'Synthetic native PostgreSQL integration verification attestation.';
const j = JSON.stringify;

export interface PgSessionLike {
  backendPid: number;
  exec(sql: string): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  transaction<T>(fn: (tx: PgSessionLike) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class PgTestClient implements PgSessionLike {
  readonly client: Client;
  backendPid = 0;

  private constructor(connectionString: string) {
    this.client = new Client({ connectionString });
  }

  static async connect(connectionString: string): Promise<PgTestClient> {
    const instance = new PgTestClient(connectionString);
    await instance.client.connect();
    const pidRes = await instance.client.query<{ pid: number }>(
      'select pg_backend_pid()::integer as pid',
    );
    instance.backendPid = Number(pidRes.rows[0]?.pid ?? 0);
    return instance;
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[] }> {
    const res =
      params.length > 0 ? await this.client.query(sql, params) : await this.client.query(sql);
    return { rows: res.rows as T[] };
  }

  async transaction<T>(fn: (tx: PgSessionLike) => Promise<T>): Promise<T> {
    await this.exec('begin');
    try {
      const out = await fn(this);
      await this.exec('commit');
      return out;
    } catch (err) {
      try {
        await this.exec('rollback');
      } catch {
        // Ignore rollback errors if connection already aborted
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

export function buildDisposablePostgresUrl(baseUrl: string, disposableDbName: string): string {
  assert.match(disposableDbName, /^verify_disp_[0-9]+_[0-9a-f]{8}$/);
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${disposableDbName}`;
  return parsed.toString();
}

export async function withDisposablePostgresDatabase<T>(
  baseUrl: string,
  fn: (disposableUrl: string, disposableDbName: string) => Promise<T>,
  connectFn: (url: string) => Promise<PgSessionLike> = (url) => PgTestClient.connect(url),
): Promise<{ result: T; disposableDbName: string }> {
  const disposableDbName = `verify_disp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  assert.match(disposableDbName, /^verify_disp_[0-9]+_[0-9a-f]{8}$/);
  const disposableUrl = buildDisposablePostgresUrl(baseUrl, disposableDbName);

  const control = await connectFn(baseUrl);
  try {
    await control.exec(`create database ${disposableDbName}`);
    const result = await fn(disposableUrl, disposableDbName);
    return { result, disposableDbName };
  } finally {
    try {
      await control.query(
        'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
        [disposableDbName],
      );
      await control.exec(`drop database if exists ${disposableDbName}`);
    } finally {
      await control.close();
    }
  }
}

test('disposable PostgreSQL database harness creates an isolated database, never drops schemas, and preserves unrelated existing data', async () => {
  const executedByDb = new Map<string, string[]>();
  const existingDataInSuppliedDb = new Map<string, string>([
    ['unrelated_schema.existing_records', 'preserved-row-1'],
  ]);
  const createdDatabases = new Set<string>(['supplied_db']);
  const forbiddenDropSchemaPattern = new RegExp('drop\\s+' + 'schema', 'i');

  const fakeConnect = async (url: string): Promise<PgSessionLike> => {
    const dbName = new URL(url).pathname.replace(/^\//, '');
    if (!executedByDb.has(dbName)) {
      executedByDb.set(dbName, []);
    }
    const recordSql = (sql: string) => {
      assert.doesNotMatch(
        sql,
        forbiddenDropSchemaPattern,
        `Harness must never execute schema drops (saw: ${sql})`,
      );
      executedByDb.get(dbName)!.push(sql.trim());
      const createMatch = sql.match(/^create database (verify_disp_[0-9]+_[0-9a-f]{8})$/i);
      if (createMatch) {
        createdDatabases.add(createMatch[1]);
      }
      const dropMatch = sql.match(/^drop database if exists (verify_disp_[0-9]+_[0-9a-f]{8})$/i);
      if (dropMatch) {
        createdDatabases.delete(dropMatch[1]);
      }
    };
    const session: PgSessionLike = {
      backendPid: 1001,
      async exec(sql: string) {
        recordSql(sql);
      },
      async query<T = Record<string, unknown>>(sql: string) {
        recordSql(sql);
        return { rows: [] as T[] };
      },
      async transaction<T>(fn: (tx: PgSessionLike) => Promise<T>) {
        return fn(session);
      },
      async close() {},
    };
    return session;
  };

  const baseUrl = 'postgres://postgres:postgres@127.0.0.1:5432/supplied_db';
  const { result, disposableDbName } = await withDisposablePostgresDatabase(
    baseUrl,
    async (disposableUrl, dbName) => {
      assert.notEqual(disposableUrl, baseUrl);
      assert.equal(new URL(disposableUrl).pathname, `/${dbName}`);
      assert.equal(createdDatabases.has(dbName), true);
      const dispConn = await fakeConnect(disposableUrl);
      await dispConn.exec('create schema if not exists extensions');
      await dispConn.close();
      return 'ok';
    },
    fakeConnect,
  );

  assert.equal(result, 'ok');
  assert.equal(createdDatabases.has(disposableDbName), false);
  assert.equal(createdDatabases.has('supplied_db'), true);
  assert.equal(
    existingDataInSuppliedDb.get('unrelated_schema.existing_records'),
    'preserved-row-1',
  );

  const suppliedCommands = executedByDb.get('supplied_db') ?? [];
  assert.equal(
    suppliedCommands.some((cmd) => /create schema|create table|insert into/i.test(cmd)),
    false,
    'Supplied database must only be used as a control connection to create/drop the disposable database',
  );

  const selfSource = await readFile('tests/postgres-native.test.ts', 'utf8');
  assert.doesNotMatch(selfSource, forbiddenDropSchemaPattern);
});

test(
  'native PostgreSQL multi-session role isolation, negative access, and concurrency harness (distinct from live Supabase JWT/PostgREST gateway verification)',
  {
    skip:
      !process.env.VERIFY_PG_TEST_URL &&
      process.env.VERIFY_PG_REQUIRE !== '1' &&
      'BLOCKED locally: set VERIFY_PG_TEST_URL to a native PostgreSQL instance (runs in GitHub Actions postgres:16 job). Distinct from deployed Supabase JWT/PostgREST tests.',
  },
  async () => {
    const pgUrl = process.env.VERIFY_PG_TEST_URL;
    assert.ok(
      pgUrl,
      'VERIFY_PG_REQUIRE=1 is set, but VERIFY_PG_TEST_URL is missing; native PostgreSQL harness requires a reachable PostgreSQL server',
    );

    // Record user tables in the supplied database (VERIFY_PG_TEST_URL) before running;
    // the harness must never create tables or insert/update rows in the supplied database.
    const suppliedBeforeConn = await PgTestClient.connect(pgUrl);
    let suppliedTablesBefore: Array<{ schemaname: string; tablename: string }> = [];
    try {
      suppliedTablesBefore = (
        await suppliedBeforeConn.query<{ schemaname: string; tablename: string }>(
          "select schemaname, tablename from pg_tables where schemaname not in ('pg_catalog', 'information_schema') order by schemaname, tablename",
        )
      ).rows;
    } finally {
      await suppliedBeforeConn.close();
    }

    // Create a separate disposable database to hold the preservation-test sentinel,
    // then pass that sentinel database URL as the base URL to withDisposablePostgresDatabase.
    await withDisposablePostgresDatabase(pgUrl, async (sentinelDbUrl) => {
      const sentinelSeed = await PgTestClient.connect(sentinelDbUrl);
      try {
        await sentinelSeed.exec(`
          create schema unrelated_existing_schema;
          create table unrelated_existing_schema.preserved_sentinel (
            sentinel_id text primary key,
            payload text not null
          );
          insert into unrelated_existing_schema.preserved_sentinel (sentinel_id, payload)
          values ('preserve-1', 'unrelated-supplied-db-data');
        `);
      } finally {
        await sentinelSeed.close();
      }

      await withDisposablePostgresDatabase(sentinelDbUrl, async (disposableUrl) => {
        const admin = await PgTestClient.connect(disposableUrl);
        const conn1 = await PgTestClient.connect(disposableUrl);
        const conn2 = await PgTestClient.connect(disposableUrl);
        const conn3 = await PgTestClient.connect(disposableUrl);

        try {
          // Initialize extensions and migrations inside the fresh disposable database without dropping schemas
          await admin.exec(`
            grant all on schema public to public;
            create schema if not exists extensions;
            create extension if not exists pgcrypto with schema extensions;
          `);

          for (const file of [
            'supabase_test_shim/auth_shim.sql',
            'schema.sql',
            'migrations/0002_v3_review_design.sql',
            'migrations/0003_v4_record_categories_module_b.sql',
            'migrations/0004_synthetic_verify_workflow.sql',
            'migrations/0005_review_integrity_fixes.sql',
            'migrations/0006_reference_integrity.sql',
            'migrations/0007_frozen_contract_guards.sql',
            'migrations/0008_trial_packet_and_concurrency_guards.sql',
            'migrations/0009_canonical_packet_and_lock_state_guards.sql',
          ]) {
            await admin.exec(await readFile(file, 'utf8'));
          }

          const ACTORS = {
            investigator: '00000000-0000-4000-8000-0000000000c1',
            pilotA: '00000000-0000-4000-8000-0000000000c2',
            pilotB: '00000000-0000-4000-8000-0000000000c3',
            reviewerA: '00000000-0000-4000-8000-0000000000c4',
            reviewerB: '00000000-0000-4000-8000-0000000000c5',
            adjudicator: '00000000-0000-4000-8000-0000000000c6',
            adjudicator2: '00000000-0000-4000-8000-0000000000c7',
          } as const;
          type Role = keyof typeof ACTORS;

          for (const [role, id] of Object.entries(ACTORS)) {
            const email = `pg-${role.toLowerCase()}@example.invalid`;
            const appRole =
              role === 'investigator'
                ? 'INVESTIGATOR'
                : role.startsWith('adjudicator')
                  ? 'ADJUDICATOR'
                  : 'REVIEWER';
            await admin.query('insert into auth.users(id,email) values($1,$2)', [id, email]);
            await admin.query(
              'insert into public.users(user_id,auth_uid,email,display_name,role,is_pilot_test_account) values($1,$1,$2,$3,$4,$5)',
              [id, email, `Synthetic ${role}`, appRole, role.startsWith('pilot')],
            );
          }

          const asRoleOn = async <T = unknown>(
            conn: PgSessionLike,
            who: Role,
            sql: string,
            params: unknown[] = [],
            aal = 'aal2',
          ): Promise<T> =>
            conn.transaction(async (tx) => {
              await tx.exec('set local role authenticated');
              await tx.query("select set_config('request.jwt.claims',$1,true)", [
                j({ sub: ACTORS[who], aal }),
              ]);
              const res = await tx.query<Record<string, T>>(sql, params);
              return Object.values(res.rows[0] ?? {})[0];
            });

          const asRole = <T = unknown>(
            who: Role,
            sql: string,
            params: unknown[] = [],
            aal = 'aal2',
          ) => asRoleOn<T>(admin, who, sql, params, aal);

          const waitForBackendLock = async (pid: number) => {
            for (let i = 0; i < 120; i++) {
              const stat = await admin.query<{ wait_event_type: string | null }>(
                'select wait_event_type from pg_stat_activity where pid = $1',
                [pid],
              );
              if (stat.rows[0]?.wait_event_type === 'Lock') {
                return true;
              }
              await new Promise((r) => setTimeout(r, 15));
            }
            return false;
          };

          // 1. Role isolation & negative access checks for anon and non-MFA investigator
          for (const forbiddenSql of [
            'select * from public.cases',
            'select * from public.case_design',
            'select * from public.case_design_v3',
            'select * from public.frozen_predictions_v4',
            'select * from public.reviews',
            'select * from public.adjudications',
          ]) {
            await assert.rejects(
              admin.transaction(async (tx) => {
                await tx.exec('set local role anon');
                return tx.query(forbiddenSql);
              }),
              /permission denied/,
            );
          }

          await assert.rejects(
            asRole(
              'investigator',
              'select public.rpc_enroll_reviewer($1,$2,$3)',
              [ACTORS.pilotA, 'PILOT', 'Should fail without MFA aal2'],
              'aal1',
            ),
            /investigator role \(with multi-factor session when required\)/,
          );

          // Complete 10-case pilot sign-off
          const pseudo = {} as Record<'pilotA' | 'pilotB' | 'reviewerA' | 'reviewerB', string>;
          for (const role of ['pilotA', 'pilotB'] as const) {
            pseudo[role] = await asRole<string>(
              'investigator',
              'select public.rpc_enroll_reviewer($1,$2,$3)',
              [ACTORS[role], 'PILOT', 'Synthetic pilot reviewer'],
            );
          }

          await asRole('investigator', 'select public.rpc_register_ontology_version($1)', [
            j({
              ontology_version: '1.0.0',
              rule_version: '1.0.0',
              rubric_version: 'R-TEST',
              classification_schema_version: '1.0.0',
              protocol_version: 'P-TEST',
              sampling_design_version: 'SYN-PG-V4',
              ontology_sha256: 'b'.repeat(64),
              classification_schema_sha256: 'c'.repeat(64),
              rubric_sha256: 'd'.repeat(64),
              frozen_at: '2026-10-20T00:00:00Z',
              notes: 'Synthetic native PG test',
            }),
          ]);

          const makeCase = (
            caseId: string,
            mode: 'PILOT' | 'FORMAL',
            unitType: 'DESCRIPTOR_AREA' | 'TRIAL_AREA',
            area: string,
            nctId?: string,
          ) => ({
            case_id: caseId,
            mode,
            unit_type: unitType,
            version_set_id: '1.0.0+R-TEST',
            l1_applicable: true,
            l2_applicable: false,
            l3_applicable: false,
            packet: {
              schema_version: '1.0',
              case_title: `Fictional ${caseId}`,
              question: 'Does this fictional unit belong?',
              unit: { unit_type: unitType, unit_id: `SYN-${caseId}::${area}` },
              descriptor: {
                descriptor_ui: `SYN-${caseId}`,
                name: `Fictional descriptor ${caseId}`,
              },
              mesh: { scope_note: 'SYNTHETIC ENGINEERING ONLY', tree_numbers: ['SYN.001'] },
              area: { key: area, label: `Fictional ${area}` },
              ...(unitType === 'TRIAL_AREA'
                ? { trial: { nct_id: nctId!, brief_title: `Fictional trial ${caseId}` } }
                : {}),
            },
            change_reason: 'Synthetic initial version',
            design: {
              unit_id: `SYN-${caseId}::${area}`,
              descriptor_ui: `SYN-${caseId}`,
              descriptor_name: `Fictional descriptor ${caseId}`,
              area,
              ...(unitType === 'TRIAL_AREA' ? { nct_id: nctId! } : {}),
              primary_stratum: 'SYN-STRATUM',
              selection_probability: 0.5,
              frame_stratum_size: 20,
              sampling_design_version: 'SYN-PG-V4',
              sampling_seed: 123,
              trial_frequency_weight: 1,
              n_trials_primary: 1,
              original_l1_decision: 'INCLUDE',
              source_file: 'synthetic',
              source_row_sha256: 'a'.repeat(64),
            },
          });

          const pilotIds = Array.from(
            { length: 10 },
            (_, i) => `SYN-${String(i + 1).padStart(3, '0')}`,
          );
          for (const pid of pilotIds) {
            await asRole('investigator', 'select public.rpc_import_case($1)', [
              j(makeCase(pid, 'PILOT', 'DESCRIPTOR_AREA', 'infectious')),
            ]);
          }
          for (const [slot, role] of (['pilotA', 'pilotB'] as const).entries()) {
            await asRole('investigator', 'select public.rpc_assign_cases($1,$2,$3,$4,$5)', [
              'PILOT',
              pseudo[role],
              slot + 1,
              pilotIds,
              123,
            ]);
            const assignments = (
              await admin.query<{ assignment_id: string }>(
                'select assignment_id from public.assignments where reviewer_pseudo_id=$1',
                [pseudo[role]],
              )
            ).rows;
            for (const a of assignments) {
              await asRole(role, 'select public.rpc_submit_review($1,$2)', [
                a.assignment_id,
                j({
                  l1_decision: 'INCLUDE',
                  l1_rationale: 'Synthetic pilot judgment.',
                  l1_uncertain: false,
                }),
              ]);
            }
          }
          for (const pid of pilotIds) {
            await asRole(
              'investigator',
              "select public.rpc_record_adjudication($1,'clinical_classification','INCLUDE',null,'CONCORDANT_CONFIRMED','BOTH_REVIEWERS','Synthetic pilot adjudication',null,array(select review_id from public.v_effective_reviews where case_id=$1),null,null,false)",
              [pid],
            );
          }
          const pilotExportId = await asRole(
            'investigator',
            'select public.rpc_register_export($1)',
            [
              j({
                mode: 'PILOT',
                export_type: 'ANALYSIS',
                export_format_version: '1',
                version_set_id: '1.0.0+R-TEST',
                ontology_version: '1.0.0',
                rule_version: '1.0.0',
                rubric_version: 'R-TEST',
                classification_schema_version: '1.0.0',
                sampling_design_version: 'SYN-PG-V4',
                app_git_sha: 'abc123',
                row_counts: { rows: 10 },
                file_sha256: { 'synthetic.csv': '2'.repeat(64) },
              }),
            ],
          );
          await asRole('investigator', 'select public.rpc_unlock_formal_review($1,$2,$3,$4,$5)', [
            'SYN-PILOT-CHECKLIST',
            '1'.repeat(64),
            'abc123',
            pilotExportId,
            ATT,
          ]);

          for (const role of ['reviewerA', 'reviewerB'] as const) {
            pseudo[role] = await asRole<string>(
              'investigator',
              'select public.rpc_enroll_reviewer($1,$2,$3)',
              [ACTORS[role], 'FORMAL', 'Synthetic formal reviewer'],
            );
          }
          await asRole('investigator', 'select public.rpc_activate_design_v4($1,$2,$3)', [
            'SYN-PG-V4',
            'DISAGREEMENTS_ONLY',
            ATT,
          ]);

          // Set up 2 held-out formal cases: 1 DESCRIPTOR_AREA and 1 two-step TRIAL_AREA
          const descId = 'HO4-TESTFX-001';
          const trialId = 'HO4-TESTFX-002';
          await asRole('investigator', 'select public.rpc_import_case($1)', [
            j(makeCase(descId, 'FORMAL', 'DESCRIPTOR_AREA', 'infectious')),
          ]);
          await asRole('investigator', 'select public.rpc_import_case($1)', [
            j(makeCase(trialId, 'FORMAL', 'TRIAL_AREA', 'cardiovascular', 'SYN-NCT-0002')),
          ]);

          for (const [cid, isTrial] of [
            [descId, false],
            [trialId, true],
          ] as const) {
            await asRole('investigator', 'select public.rpc_set_case_design_v3($1)', [
              j({
                case_id: cid,
                mode: 'FORMAL',
                review_module: 'ONTOLOGY_AREA',
                analysis_set: 'VALIDATION_HELDOUT',
                selection_stratum: 'SYN-STRATUM',
                variance_stratum: 'SYN-VAR',
                variance_stratum_size: 20,
                selection_probability: 0.5,
                comparison_cell_v11: 'OPOS_CPOS',
                original_binary: 'INCLUDE',
                curated_v11_status_raw: isTrial ? 'CONTEXT_DEPENDENT' : 'INCLUDE',
                curated_v11_binary: 'INCLUDE',
                two_step_required: isTrial,
                sampling_design_version: 'SYN-PG-V4',
              }),
            ]);
            await asRole('investigator', 'select public.rpc_record_heldout_case_v4($1)', [
              j({
                case_id: cid,
                record_category: 'HELDOUT_FORMAL',
                frame_unit_id: `SYN-FRAME-${cid}`,
                impact_tier: 'STANDARD',
                policy_governed_neoplasm_gen06: false,
                provenance_audit_result: 'NO_DEVELOPMENT_FLAG',
              }),
            ]);
          }

          const trialContextPacket = {
            schema_version: '1.0',
            trial: {
              nct_id: 'SYN-NCT-0002',
              brief_title: 'Fictional Step-2 trial context',
              conditions: ['Fictional condition'],
              summary: 'Synthetic Step-2 context packet.',
            },
            notices: ['SYNTHETIC ENGINEERING ONLY'],
          };
          await asRole('investigator', 'select public.rpc_add_trial_context_packet($1,$2)', [
            trialId,
            j(trialContextPacket),
          ]);

          await asRole('investigator', 'select public.rpc_import_frozen_predictions_v4($1)', [
            j([
              {
                prediction_set_id: 'SYN-PG-PRED',
                case_id: descId,
                determination_level: 'DESCRIPTOR_LEVEL',
                tier0_binary: 'INCLUDE',
                tier1_version: 'v1.1',
                tier1_status_raw: 'INCLUDE',
                tier1_binary: 'INCLUDE',
              },
              {
                prediction_set_id: 'SYN-PG-PRED',
                case_id: trialId,
                determination_level: 'DESCRIPTOR_LEVEL_IN_TRIAL_CASE',
                tier0_binary: 'INCLUDE',
                tier1_version: 'v1.1',
                tier1_status_raw: 'CONTEXT_DEPENDENT',
                tier1_binary: 'INCLUDE',
              },
              {
                prediction_set_id: 'SYN-PG-PRED',
                case_id: trialId,
                determination_level: 'TRIAL_LEVEL',
                tier0_binary: 'INCLUDE',
                tier1_version: 'v1.1',
                tier1_status_raw: 'CONTEXT_DEPENDENT',
                tier1_binary: 'INCLUDE',
                stage_c_trial_status: 'INCLUDE',
              },
            ]),
          ]);

          await asRole('investigator', 'select public.rpc_freeze_sample_manifest($1)', [
            j({
              review_module: 'ONTOLOGY_AREA',
              sampling_design_version: 'SYN-PG-V4',
              manifest_file_sha256: '3'.repeat(64),
              decision_file_v11_sha256: '4'.repeat(64),
              sampling_seed: 123,
              attestation: ATT,
            }),
          ]);

          const investigatorQueryable: V4DbQueryable = {
            query: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
              admin.transaction(async (tx) => {
                await tx.exec('set local role authenticated');
                await tx.query("select set_config('request.jwt.claims',$1,true)", [
                  j({ sub: ACTORS.investigator, aal: 'aal2' }),
                ]);
                return tx.query<T>(sql, params);
              }),
          };

          const predictionFileSha256 =
            await computeV4PredictionFileSha256FromDb(investigatorQueryable);

          // 2. True multi-connection concurrency: freeze in conn1 blocks BOTH concurrent case withdrawal (conn2)
          //    and concurrent packet versioning (conn3)
          await conn1.exec('begin');
          await conn1.exec('set local role authenticated');
          await conn1.query("select set_config('request.jwt.claims',$1,true)", [
            j({ sub: ACTORS.investigator, aal: 'aal2' }),
          ]);
          await conn1.query('select public.rpc_freeze_v4($1)', [
            j({
              tier1_version: 'v1.1',
              prediction_file_sha256: predictionFileSha256,
              frozen_items: {
                ontology_sha256: '1'.repeat(64),
                tier1_decision_file_sha256: '2'.repeat(64),
                tier0_mapping_sha256: '3'.repeat(64),
                rubric_sha256: '4'.repeat(64),
                provenance_audit_sha256: '5'.repeat(64),
              },
              attestation: ATT,
            }),
          ]);

          const concurrentWithdrawRejection = assert.rejects(
            asRoleOn(conn2, 'investigator', 'select public.rpc_withdraw_case($1,$2)', [
              descId,
              'Concurrent withdrawal during freeze must block and fail.',
            ]),
            /is a frozen held-out case and cannot be withdrawn/,
          );

          const concurrentVersionRejection = assert.rejects(
            asRoleOn(
              conn3,
              'investigator',
              'select public.rpc_add_case_version($1,$2::jsonb,$3,$4,$5,$6,$7)',
              [
                descId,
                j({
                  schema_version: '1.0',
                  case_title: `Fictional ${descId} v2`,
                  question: 'Does this fictional unit belong?',
                  unit: { unit_type: 'DESCRIPTOR_AREA', unit_id: `SYN-${descId}::infectious` },
                  descriptor: {
                    descriptor_ui: `SYN-${descId}`,
                    name: `Fictional descriptor ${descId}`,
                  },
                  mesh: { scope_note: 'SYNTHETIC ENGINEERING ONLY', tree_numbers: ['SYN.001'] },
                  area: { key: 'infectious', label: 'Fictional infectious' },
                }),
                '1.0.0+R-TEST',
                true,
                false,
                false,
                'Concurrent packet versioning during freeze must block and fail.',
              ],
            ),
            /Frozen held-out evidence packets cannot be versioned/,
          );

          assert.equal(await waitForBackendLock(conn2.backendPid), true);
          assert.equal(await waitForBackendLock(conn3.backendPid), true);
          await conn1.exec('commit');

          await Promise.all([concurrentWithdrawRejection, concurrentVersionRejection]);

          // Assign formal cases to reviewerA and reviewerB
          for (const [slot, role] of (['reviewerA', 'reviewerB'] as const).entries()) {
            await asRole('investigator', 'select public.rpc_assign_cases($1,$2,$3,$4,$5)', [
              'FORMAL',
              pseudo[role],
              slot + 1,
              [descId, trialId],
              303,
            ]);
          }

          // 3. Reviewer blinding & delayed Step-2 disclosure under real PostgreSQL RLS
          for (const blindedTable of [
            'public.case_design',
            'public.case_design_v3',
            'public.case_records_v4',
            'public.frozen_predictions_v4',
            'public.freeze_manifests_v4',
          ]) {
            assert.equal(
              await asRole<number>('reviewerA', `select count(*)::integer from ${blindedTable}`),
              0,
              `Reviewer must see 0 rows in RLS-blinded table ${blindedTable}`,
            );
            assert.equal(
              (await asRole<number>(
                'investigator',
                `select count(*)::integer from ${blindedTable}`,
              )) > 0,
              true,
            );
          }

          // Before recording Step 1, reviewerA cannot see the Step-2 trial_context_packets row
          const step2Before = await asRole<number>(
            'reviewerA',
            'select count(*)::integer from public.trial_context_packets where case_id=$1',
            [trialId],
          );
          assert.equal(step2Before, 0);

          // Submit reviews (discordant on descId, concordant on trialId)
          for (const [slot, role] of (['reviewerA', 'reviewerB'] as const).entries()) {
            const assignments = (
              await admin.query<{ assignment_id: string; case_id: string }>(
                "select assignment_id, case_id from public.assignments where mode='FORMAL' and reviewer_pseudo_id=$1 order by case_id",
                [pseudo[role]],
              )
            ).rows;
            for (const a of assignments) {
              if (a.case_id === trialId) {
                await asRole(role, 'select public.rpc_record_trial_step1($1,$2)', [
                  a.assignment_id,
                  j({
                    step1_decision: 'INCLUDE',
                    step1_rationale: 'Synthetic Step 1 decision.',
                    step1_uncertain: false,
                  }),
                ]);
                if (role === 'reviewerA') {
                  const step2After = await asRole<number>(
                    'reviewerA',
                    'select count(*)::integer from public.trial_context_packets where case_id=$1',
                    [trialId],
                  );
                  assert.equal(step2After, 1);
                }
              }
              const decision = a.case_id === descId && slot === 1 ? 'EXCLUDE' : 'INCLUDE';
              await asRole(role, 'select public.rpc_submit_review($1,$2)', [
                a.assignment_id,
                j({
                  l1_decision: decision,
                  l1_rationale: 'Synthetic formal review decision.',
                  l1_uncertain: false,
                }),
              ]);
            }
          }

          // 4. True multi-connection concurrency: concurrent review amendments on the same assignment
          const reviewerADescAssignmentId = (
            await admin.query<{ assignment_id: string }>(
              "select assignment_id from public.assignments where mode='FORMAL' and reviewer_pseudo_id=$1 and case_id=$2",
              [pseudo.reviewerA, descId],
            )
          ).rows[0].assignment_id;

          await conn1.exec('begin');
          await conn1.exec('set local role authenticated');
          await conn1.query("select set_config('request.jwt.claims',$1,true)", [
            j({ sub: ACTORS.reviewerA, aal: 'aal2' }),
          ]);
          await conn1.query('select public.rpc_submit_review($1,$2)', [
            reviewerADescAssignmentId,
            j({
              l1_decision: 'INCLUDE',
              l1_rationale: 'First concurrent amendment revision.',
              l1_uncertain: false,
            }),
          ]);

          const concurrentAmendRejection = assert.rejects(
            asRoleOn(conn2, 'reviewerA', 'select public.rpc_submit_review($1,$2)', [
              reviewerADescAssignmentId,
              j({
                l1_decision: 'INCLUDE',
                l1_rationale: 'Second concurrent amendment revision racing for revision 2.',
                l1_uncertain: false,
              }),
            ]),
            /duplicate key value violates unique constraint/,
          );

          assert.equal(await waitForBackendLock(conn2.backendPid), true);
          await conn1.exec('commit');

          await concurrentAmendRejection;

          // Reviewer A can see only their own 3 review rows (2 initial + 1 amendment), never Reviewer B's reviews
          assert.equal(
            await asRole<number>(
              'reviewerA',
              "select count(*)::integer from public.reviews where mode='FORMAL'",
            ),
            3,
          );

          await asRole('investigator', 'select public.rpc_close_formal_review($1,$2)', [true, ATT]);
          await asRole('investigator', 'select public.rpc_snapshot_judgments_v4()');

          // 5. True multi-connection concurrency: concurrent formal adjudications on the same case level
          const consideredDesc = (
            await admin.query<{ review_id: string }>(
              'select review_id from public.v_effective_reviews where case_id=$1',
              [descId],
            )
          ).rows.map((r) => r.review_id);

          await conn1.exec('begin');
          await conn1.exec('set local role authenticated');
          await conn1.query("select set_config('request.jwt.claims',$1,true)", [
            j({ sub: ACTORS.adjudicator, aal: 'aal2' }),
          ]);
          await conn1.query('select public.rpc_record_adjudication_v3($1)', [
            j({
              case_id: descId,
              determination_level: 'DESCRIPTOR_LEVEL',
              layer: 'clinical_classification',
              decision: 'INCLUDE',
              status: 'DISCORDANT_RESOLVED',
              basis: 'REVIEWER_1',
              reason_code: 'CONSTRUCT_BOUNDARY',
              rationale: 'First adjudicator session resolves discordance.',
              considered_ids: consideredDesc,
            }),
          ]);

          const concurrentAdjudicationRejection = assert.rejects(
            asRoleOn(conn2, 'adjudicator2', 'select public.rpc_record_adjudication_v3($1)', [
              j({
                case_id: descId,
                determination_level: 'DESCRIPTOR_LEVEL',
                layer: 'clinical_classification',
                decision: 'EXCLUDE',
                status: 'DISCORDANT_RESOLVED',
                basis: 'REVIEWER_2',
                reason_code: 'CONSTRUCT_BOUNDARY',
                rationale: 'Concurrent adjudicator session without supersession ID.',
                considered_ids: consideredDesc,
              }),
            ]),
            /a new adjudication must supersede the current one/,
          );

          assert.equal(await waitForBackendLock(conn2.backendPid), true);
          await conn1.exec('commit');

          await concurrentAdjudicationRejection;

          // 6. True multi-connection concurrency: reference lock in conn1 vs assignment withdrawal (conn2)
          //    AND concurrent migration 0009 preflight lock guard (conn3)
          const targetAssignmentId = (
            await admin.query<{ assignment_id: string }>(
              "select assignment_id from public.assignments where mode='FORMAL' limit 1",
            )
          ).rows[0].assignment_id;

          const migration0009Sql = await readFile(
            'migrations/0009_canonical_packet_and_lock_state_guards.sql',
            'utf8',
          );

          await conn1.exec('begin');
          await conn1.exec('set local role authenticated');
          await conn1.query("select set_config('request.jwt.claims',$1,true)", [
            j({ sub: ACTORS.investigator, aal: 'aal2' }),
          ]);
          await conn1.query('select public.rpc_lock_reference_v4($1)', [ATT]);

          const concurrentAssignmentWithdrawRejection = assert.rejects(
            asRoleOn(conn2, 'investigator', 'select public.rpc_withdraw_assignment($1,$2)', [
              targetAssignmentId,
              'Concurrent assignment withdrawal during reference lock.',
            ]),
            /Locked reference prevents assignment withdrawal/,
          );

          const concurrentMigrationRejection = assert.rejects(
            conn3.exec(migration0009Sql).catch(async (err) => {
              await conn3.exec('rollback').catch(() => {});
              throw err;
            }),
            /Existing locked formal reference requires explicit investigator migration review/,
          );

          assert.equal(await waitForBackendLock(conn2.backendPid), true);
          assert.equal(await waitForBackendLock(conn3.backendPid), true);
          await conn1.exec('commit');

          await Promise.all([concurrentAssignmentWithdrawRejection, concurrentMigrationRejection]);

          // Verify full DB integrity and export from the native PostgreSQL database
          const integrity = await verifyV4DatabaseIntegrity(investigatorQueryable);
          assert.equal(integrity.frozenPredictionsMatch, true);
          assert.equal(integrity.judgmentSnapshotMatch, true);

          const bundle = await exportV4SyntheticBundleFromDb(investigatorQueryable);
          assert.equal(bundle.files[0].rows, 6);
          assert.equal(bundle.files[1].rows, 3);
          assert.equal(bundle.files[2].rows, 3);
        } finally {
          await conn3.close();
          await conn2.close();
          await conn1.close();
          await admin.close();
        }
      });

      // Verify the sentinel disposable database's unrelated existing data was completely preserved
      const sentinelVerify = await PgTestClient.connect(sentinelDbUrl);
      try {
        const preserved = await sentinelVerify.query<{ sentinel_id: string; payload: string }>(
          "select sentinel_id, payload from unrelated_existing_schema.preserved_sentinel where sentinel_id = 'preserve-1'",
        );
        assert.deepEqual(preserved.rows, [
          { sentinel_id: 'preserve-1', payload: 'unrelated-supplied-db-data' },
        ]);
      } finally {
        await sentinelVerify.close();
      }
    });

    // Verify no tables were created in the database supplied through VERIFY_PG_TEST_URL
    const suppliedAfterConn = await PgTestClient.connect(pgUrl);
    try {
      const suppliedTablesAfter = (
        await suppliedAfterConn.query<{ schemaname: string; tablename: string }>(
          "select schemaname, tablename from pg_tables where schemaname not in ('pg_catalog', 'information_schema') order by schemaname, tablename",
        )
      ).rows;
      assert.deepEqual(suppliedTablesAfter, suppliedTablesBefore);
    } finally {
      await suppliedAfterConn.close();
    }
  },
);
