import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import test from 'node:test';
import {
  computeV4PredictionFileSha256FromDb,
  exportV4SyntheticBundleFromDb,
  verifyV4DatabaseIntegrity,
  type V4DbQueryable,
} from '../src/lib/formal-export';
import { PgWireConnection, parsePgConnectionUrl } from '../src/lib/pg-wire';

const ATT = 'Synthetic native PostgreSQL integration verification attestation.';
const j = JSON.stringify;

function frameServerMsg(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeInt32BE(body.length + 4, 0);
  return Buffer.concat([Buffer.from(type, 'ascii'), len, body]);
}

test('pg-wire client parses URLs, completes SCRAM-SHA-256 auth, and decodes typed rows over TCP', async () => {
  const parsed = parsePgConnectionUrl('postgres://verify_user:secret@127.0.0.1:5433/verify_db');
  assert.deepEqual(parsed, {
    host: '127.0.0.1',
    port: 5433,
    user: 'verify_user',
    password: 'secret',
    database: 'verify_db',
  });

  const password = 'synthetic-scram-password';
  const salt = crypto.randomBytes(16);
  const iterations = 4096;
  const serverNonceSuffix = 'serverNonce123';

  const server = net.createServer((socket) => {
    let stage = 'startup';
    let clientFirstBare = '';
    let fullNonce = '';
    let serverFirst = '';

    socket.on('data', (chunk: Buffer) => {
      if (stage === 'startup') {
        stage = 'sasl-initial';
        // Send AuthenticationSASL (10) offering SCRAM-SHA-256
        const code = Buffer.alloc(4);
        code.writeInt32BE(10, 0);
        const mech = Buffer.from('SCRAM-SHA-256\0\0', 'utf8');
        socket.write(frameServerMsg('R', Buffer.concat([code, mech])));
        return;
      }
      if (stage === 'sasl-initial') {
        stage = 'sasl-final';
        // Extract client-first-message
        const str = chunk.toString('utf8');
        const idx = str.indexOf('n,,');
        clientFirstBare = str.slice(idx + 3);
        const clientNonce = clientFirstBare.split(',')[1].slice(2);
        fullNonce = clientNonce + serverNonceSuffix;
        serverFirst = `r=${fullNonce},s=${salt.toString('base64')},i=${iterations}`;
        const code = Buffer.alloc(4);
        code.writeInt32BE(11, 0);
        socket.write(frameServerMsg('R', Buffer.concat([code, Buffer.from(serverFirst, 'utf8')])));
        return;
      }
      if (stage === 'sasl-final') {
        stage = 'ready';
        const saltedPassword = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
        const serverKey = crypto.createHmac('sha256', saltedPassword).update('Server Key').digest();
        const clientFinalWithoutProof = `c=biws,r=${fullNonce}`;
        const authMessage = `${clientFirstBare},${serverFirst},${clientFinalWithoutProof}`;
        const serverSig = crypto
          .createHmac('sha256', serverKey)
          .update(authMessage)
          .digest('base64');
        const code12 = Buffer.alloc(4);
        code12.writeInt32BE(12, 0);
        const code0 = Buffer.alloc(4);
        code0.writeInt32BE(0, 0);
        const keyData = Buffer.alloc(8);
        keyData.writeInt32BE(4242, 0);
        keyData.writeInt32BE(9999, 4);
        socket.write(
          Buffer.concat([
            frameServerMsg('R', Buffer.concat([code12, Buffer.from(`v=${serverSig}`, 'utf8')])),
            frameServerMsg('R', code0),
            frameServerMsg('K', keyData),
            frameServerMsg('Z', Buffer.from('I', 'ascii')),
          ]),
        );
        return;
      }
      if (stage === 'ready') {
        const msgType = String.fromCharCode(chunk[0]);
        if (msgType === 'Q') {
          socket.write(
            Buffer.concat([
              frameServerMsg('C', Buffer.from('BEGIN\0', 'utf8')),
              frameServerMsg('Z', Buffer.from('T', 'ascii')),
            ]),
          );
        } else if (msgType === 'P') {
          // Respond with RowDescription ('T') + DataRow ('D') + CommandComplete ('C') + ReadyForQuery ('Z')
          const makeField = (name: string, oid: number) => {
            const nameBuf = Buffer.from(name + '\0', 'utf8');
            const meta = Buffer.alloc(18);
            meta.writeInt32BE(oid, 6);
            return Buffer.concat([nameBuf, meta]);
          };
          const colCount = Buffer.alloc(2);
          colCount.writeInt16BE(4, 0);
          const rowDesc = Buffer.concat([
            colCount,
            makeField('ok', 16),
            makeField('n', 23),
            makeField('tags', 1009),
            makeField('doc', 3802),
          ]);
          const encodeVal = (v: string) => {
            const b = Buffer.from(v, 'utf8');
            const l = Buffer.alloc(4);
            l.writeInt32BE(b.length, 0);
            return Buffer.concat([l, b]);
          };
          const dataRow = Buffer.concat([
            colCount,
            encodeVal('t'),
            encodeVal('7'),
            encodeVal('{"alpha","beta"}'),
            encodeVal('{"synthetic":true}'),
          ]);
          socket.write(
            Buffer.concat([
              frameServerMsg('T', rowDesc),
              frameServerMsg('D', dataRow),
              frameServerMsg('C', Buffer.from('SELECT 1\0', 'utf8')),
              frameServerMsg('Z', Buffer.from('I', 'ascii')),
            ]),
          );
        } else if (msgType === 'X') {
          socket.end();
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as net.AddressInfo;
  try {
    const conn = await PgWireConnection.connect(
      `postgres://postgres:${password}@127.0.0.1:${address.port}/postgres`,
    );
    assert.equal(conn.backendPid, 4242);
    await conn.exec('begin');
    const res = await conn.query<{
      ok: boolean;
      n: number;
      tags: string[];
      doc: { synthetic: boolean };
    }>('select $1, $2', ['a', ['x', 'y']]);
    assert.deepEqual(res.rows[0], {
      ok: true,
      n: 7,
      tags: ['alpha', 'beta'],
      doc: { synthetic: true },
    });
    await conn.close();
  } finally {
    server.close();
  }
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

    const admin = await PgWireConnection.connect(pgUrl);
    const conn1 = await PgWireConnection.connect(pgUrl);
    const conn2 = await PgWireConnection.connect(pgUrl);

    try {
      // Cleanly initialize schemas and extensions on the native PostgreSQL instance
      await admin.exec(`
        drop schema if exists public cascade;
        drop schema if exists private cascade;
        drop schema if exists auth cascade;
        drop schema if exists extensions cascade;
        create schema public;
        grant all on schema public to public;
        create schema extensions;
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
        conn: PgWireConnection,
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

      const asRole = <T = unknown>(who: Role, sql: string, params: unknown[] = [], aal = 'aal2') =>
        asRoleOn<T>(admin, who, sql, params, aal);

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
          descriptor: { descriptor_ui: `SYN-${caseId}`, name: `Fictional descriptor ${caseId}` },
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
      const pilotExportId = await asRole('investigator', 'select public.rpc_register_export($1)', [
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
      ]);
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

      const predictionFileSha256 = await computeV4PredictionFileSha256FromDb(investigatorQueryable);

      // Helper to wait until conn2 is blocked on a PostgreSQL lock in pg_stat_activity
      const waitForConn2Lock = async () => {
        for (let i = 0; i < 100; i++) {
          const stat = await admin.query<{ wait_event_type: string | null }>(
            'select wait_event_type from pg_stat_activity where pid = $1',
            [conn2.backendPid],
          );
          if (stat.rows[0]?.wait_event_type === 'Lock') {
            return true;
          }
          await new Promise((r) => setTimeout(r, 15));
        }
        return false;
      };

      // 2. True multi-connection concurrency: freeze in conn1 blocks concurrent withdrawal / versioning in conn2
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

      // While conn1 holds the uncommitted freeze locks, start a concurrent case withdrawal on conn2
      const concurrentWithdrawPromise = asRoleOn(
        conn2,
        'investigator',
        'select public.rpc_withdraw_case($1,$2)',
        [descId, 'Concurrent withdrawal during freeze must block and fail.'],
      );

      assert.equal(await waitForConn2Lock(), true);
      await conn1.exec('commit');

      await assert.rejects(concurrentWithdrawPromise, /Frozen v4 cases cannot be withdrawn/);

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
        await assert.rejects(
          asRole('reviewerA', `select count(*) from ${blindedTable}`),
          /permission denied/,
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

      // Reviewer A can see only their own 2 reviews, never Reviewer B's reviews
      assert.equal(
        await asRole<number>(
          'reviewerA',
          "select count(*)::integer from public.reviews where mode='FORMAL'",
        ),
        2,
      );

      await asRole('investigator', 'select public.rpc_close_formal_review($1,$2)', [true, ATT]);
      await asRole('investigator', 'select public.rpc_snapshot_judgments_v4()');

      // 4. True multi-connection concurrency: concurrent formal adjudications on the same case level
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

      const concurrentAdjudicationPromise = asRoleOn(
        conn2,
        'adjudicator2',
        'select public.rpc_record_adjudication_v3($1)',
        [
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
        ],
      );

      assert.equal(await waitForConn2Lock(), true);
      await conn1.exec('commit');

      await assert.rejects(
        concurrentAdjudicationPromise,
        /a new adjudication must supersede the current one/,
      );

      // 5. True multi-connection concurrency: reference lock in conn1 vs assignment withdrawal in conn2
      const targetAssignmentId = (
        await admin.query<{ assignment_id: string }>(
          "select assignment_id from public.assignments where mode='FORMAL' limit 1",
        )
      ).rows[0].assignment_id;

      await conn1.exec('begin');
      await conn1.exec('set local role authenticated');
      await conn1.query("select set_config('request.jwt.claims',$1,true)", [
        j({ sub: ACTORS.investigator, aal: 'aal2' }),
      ]);
      await conn1.query('select public.rpc_lock_reference_v4($1)', [ATT]);

      const concurrentAssignmentWithdrawPromise = asRoleOn(
        conn2,
        'investigator',
        'select public.rpc_withdraw_assignment($1,$2)',
        [targetAssignmentId, 'Concurrent assignment withdrawal during reference lock.'],
      );

      assert.equal(await waitForConn2Lock(), true);
      await conn1.exec('commit');

      await assert.rejects(
        concurrentAssignmentWithdrawPromise,
        /Assignments cannot be withdrawn after a formal reference lock/,
      );

      // Verify full DB integrity and export from the native PostgreSQL database
      const integrity = await verifyV4DatabaseIntegrity(investigatorQueryable);
      assert.equal(integrity.frozenPredictionsMatch, true);
      assert.equal(integrity.judgmentSnapshotMatch, true);

      const bundle = await exportV4SyntheticBundleFromDb(investigatorQueryable);
      assert.equal(bundle.files[0].rows, 6);
      assert.equal(bundle.files[1].rows, 3);
      assert.equal(bundle.files[2].rows, 3);
    } finally {
      await conn2.close();
      await conn1.close();
      await admin.close();
    }
  },
);
