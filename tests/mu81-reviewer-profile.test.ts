import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { MU7_SYNTHETIC_TRAINING } from '../src/lib/mu7-synthetic';
import { withDisposableHandoffDatabase } from '../scripts/test-handoff-postgres-helpers.mjs';
import {
  ATT,
  FORMAL_UNITS,
  P,
  adjudicateSql,
  assignmentOf,
  as,
  freezeHashes,
  freezeSql,
  importObj,
  one,
  phase,
  rows,
  signedOffPilot,
  specifyAndApproveGates,
  submitSql,
  uidOf,
  type FixtureDb,
} from './mu7-fixture';

const MIGRATION = 'migrations/0037_v81_reviewer_profile.sql';
const PROFILE = 'mu81-plain-language-r3';
const RUBRIC = '1cd8584d68a313e60aab2f5e03f36fba66105c31b0050dec1be7d8f36ddba284';
const VERSION = 'SYN-8-1-REVIEWER-PROFILE';
const KEEP =
  'a neoplasm heading other than a cyst, hamartoma or precancerous condition, counted in the Neoplasms row';
const REMOVE =
  'cyst, hamartoma or precancerous condition only (every neoplasm heading is one of these)';
const literal = (x: unknown) => `'${JSON.stringify(x).replace(/'/g, "''")}'::jsonb`;
const BIND = { profile_id: PROFILE, rubric_sha256: RUBRIC, attestation: ATT };
const bindSql = (p: unknown = BIND) =>
  `select public.rpc_mu81_bind_reviewer_profile(${literal(p)})`;
const readProfile = (db: FixtureDb, who: Parameters<typeof one>[1] = 'inv') =>
  one(db, who, 'select public.rpc_mu81_reviewer_profile()');
type PilotImport = {
  unit_id: string;
  category: string;
  assignment_code: string;
  packet: { unit: Record<string, unknown> };
};
const INPUTS = (
  JSON.parse(readFileSync('tests/handoff/fixtures/v7/SYNTHETIC_PILOT_UNITS_v7.json', 'utf8'))
    .units as { import: PilotImport }[]
).map((u) => u.import);
const subset = () =>
  structuredClone([
    INPUTS[0],
    INPUTS.find((u) => u.category === 'RULE_K_KEPT')!,
    INPUTS.find((u) => u.category === 'RULE_K_REMOVED')!,
  ]);

test('the fixed reviewer profile checksum names the shipped guide bytes', () => {
  assert.equal(
    createHash('sha256')
      .update(readFileSync('docs/reviewer/REVIEWER_GUIDE_v81_r3.md'))
      .digest('hex'),
    RUBRIC,
  );
});

test('reviewer profile is fixed, opt-in, private, immutable and never a gate approval', async () => {
  const f = await signedOffPilot({ designVersion: VERSION, stopAfter: 'design' });
  try {
    const before = await rows(
      f.db,
      'owner',
      'select * from public.mu7_gate_requirements order by gate_id, requirement_version',
    );
    assert.equal(await readProfile(f.db), null);
    for (const who of ['pt1', 'pt2', 'r1', 'r2', 'adj', 'out', 'inv1'] as const)
      await assert.rejects(one(f.db, who, bindSql()), /investigator role/);
    for (const p of [
      null,
      [],
      {},
      { ...BIND, rubric_sha256: '0'.repeat(64) },
      { ...BIND, profile_id: 'unknown' },
      { ...BIND, attestation: ' '.repeat(30) },
      { ...BIND, attestation: { text: ATT } },
      { ...BIND, answer: 'AGREE' },
    ])
      await assert.rejects(one(f.db, 'inv', bindSql(p)), /MU81-P03|MU7-G07/);
    const digest = await one(f.db, 'inv', bindSql());
    assert.equal(
      digest,
      createHash('sha256')
        .update(['mu81-reviewer-profile-1', VERSION, PROFILE, RUBRIC].join('|'))
        .digest('hex'),
    );
    const expected = {
      profile_id: PROFILE,
      rubric_sha256: RUBRIC,
      binding_sha256: digest,
      design_version: VERSION,
    };
    for (const who of ['inv', 'pt1', 'pt2', 'r1', 'r2', 'adj'] as const)
      assert.deepEqual(await readProfile(f.db, who), expected);
    assert.equal(await readProfile(f.db, 'out'), null);
    assert.deepEqual(
      await rows(
        f.db,
        'owner',
        'select * from public.mu7_gate_requirements order by gate_id, requirement_version',
      ),
      before,
    );
    assert.equal(
      await one(f.db, 'owner', 'select count(*)::int from public.mu7_gate_approvals'),
      0,
    );
    assert.match(
      String(await one(f.db, 'owner', "select private.mu7x_unsatisfied_gates('FREEZE')")),
      /G-EST-01/,
    );
    await assert.rejects(one(f.db, 'inv', bindSql()), /duplicate key/);
    for (const sql of [
      "update public.mu7_reviewer_profile_v81 set attestation='changed synthetic attestation'",
      'delete from public.mu7_reviewer_profile_v81',
      'truncate public.mu7_reviewer_profile_v81',
    ])
      await assert.rejects(f.db.exec(sql), /append-only|immutable|not permitted|forbidden/i);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])
        assert.equal(
          await one(f.db, 'owner', 'select has_table_privilege($1,$2,$3)', [
            role,
            'public.mu7_reviewer_profile_v81',
            privilege,
          ]),
          false,
        );
      for (const fn of [
        'private.mu81_reviewer_profile_active()',
        'private.mu81_legacy_reason_ok(text,text,text)',
        'private.mu7_reason_ok(text,text,text)',
        'private.mu7_display_text(text,text)',
      ])
        assert.equal(
          await one(f.db, 'owner', 'select has_function_privilege($1,$2,$3)', [
            role,
            fn,
            'EXECUTE',
          ]),
          false,
        );
    }
    await f.db.query('insert into public.account_locks(user_id,locked_by) values($1,$2)', [
      await uidOf(f.db, 'adj'),
      'synthetic-test',
    ]);
    assert.equal(await readProfile(f.db, 'adj'), null);
    await f.db.query('insert into public.account_locks(user_id,locked_by) values($1,$2)', [
      await uidOf(f.db, 'inv'),
      'synthetic-test',
    ]);
    assert.equal(await readProfile(f.db), null);
    await assert.rejects(one(f.db, 'inv', bindSql()), /investigator role/);
  } finally {
    await f.db.close();
  }
});

test('profile binding refuses a missing or historical design and already imported review or training data', async () => {
  for (const state of ['missing', 'historical', 'unit', 'training'] as const) {
    const f = await signedOffPilot({
      designVersion: state === 'historical' ? 'SYN-7-PROFILE-COMPAT' : VERSION,
      stopAfter: state === 'missing' ? 'accounts' : 'design',
    });
    try {
      if (state === 'unit')
        await one(f.db, 'inv', `select public.rpc_mu7_import_unit(${literal(INPUTS[0])})`);
      if (state === 'training')
        await one(
          f.db,
          'inv',
          `select public.rpc_mu7_import_training_unit(${literal(MU7_SYNTHETIC_TRAINING[0])})`,
        );
      await assert.rejects(
        one(f.db, 'inv', bindSql()),
        state === 'unit' || state === 'training' ? /MU81-P02/ : /MU81-P01/,
      );
      assert.equal(await readProfile(f.db), null);
    } finally {
      await f.db.close();
    }
  }
});

test('bound K wording and reasons reach import, reviewer and adjudicator guards; bundle 8.3 carries the guide', async () => {
  const f = await signedOffPilot({ designVersion: VERSION, stopAfter: 'design' });
  try {
    await one(f.db, 'inv', bindSql());
    const [primary, kept, removed] = subset();
    for (const u of [kept, removed])
      await assert.rejects(
        one(f.db, 'inv', `select public.rpc_mu7_import_unit(${literal(u)})`),
        /MU7-G08|MU7-G09|MU7-G1[0-9]|canonical|display/,
      );
    kept.packet.unit.display_text = KEEP;
    removed.packet.unit.display_text = REMOVE;
    for (const u of [primary, kept, removed])
      await one(f.db, 'inv', `select public.rpc_mu7_import_unit(${literal(u)})`);
    const unitIds = [primary.unit_id, kept.unit_id, removed.unit_id];
    await one(
      f.db,
      'inv',
      `select public.rpc_mu7_assign_queue('PILOT',${literal({ slots: [f.PT1, f.PT2].map((pid, i) => ({ reviewer_slot: i + 1, reviewer_pseudo_id: pid, unit_ids: unitIds })) })})`,
    );
    const firstPrimary = await assignmentOf(f.db, f.PT1, primary.unit_id);
    for (const note of [undefined, '', '   ', ' a '])
      await assert.rejects(
        one(f.db, 'pt1', submitSql(firstPrimary, { answer: 'CANNOT_TELL', note })),
        /MU81-P08/,
      );
    await one(
      f.db,
      'pt1',
      submitSql(firstPrimary, {
        answer: 'CANNOT_TELL',
        note: 'Synthetic packet lacks the required detail.',
      }),
    );
    await assert.rejects(
      one(f.db, 'pt1', submitSql(firstPrimary, { answer: 'CANNOT_TELL' })),
      /MU81-P08/,
    );
    for (const [who, pid] of [
      ['pt1', f.PT1],
      ['pt2', f.PT2],
    ] as const)
      await one(
        f.db,
        who,
        submitSql(await assignmentOf(f.db, pid, primary.unit_id), { answer: 'AGREE' }),
      );
    const keptA = await assignmentOf(f.db, f.PT1, kept.unit_id);
    await assert.rejects(
      one(
        f.db,
        'pt1',
        submitSql(keptA, {
          answer: 'DISAGREE',
          reason_code: 'BENIGN_NEOPLASM',
          note: 'Synthetic observation.',
        }),
      ),
      /MU7-G35/,
    );
    await one(
      f.db,
      'pt1',
      submitSql(keptA, {
        answer: 'DISAGREE',
        reason_code: 'PRECANCEROUS',
        note: 'Synthetic observation.',
      }),
    );
    await one(
      f.db,
      'pt1',
      submitSql(await assignmentOf(f.db, f.PT1, removed.unit_id), {
        answer: 'DISAGREE',
        reason_code: 'NONMALIGNANT_NEOPLASM_STUDIED',
        note: 'Synthetic observation.',
      }),
    );
    for (const u of [kept, removed])
      await one(
        f.db,
        'pt2',
        submitSql(await assignmentOf(f.db, f.PT2, u.unit_id), { answer: 'AGREE' }),
      );
    const adj = {
      decision: 'DISAGREE',
      status: 'DISCORDANT_RESOLVED',
      basis: 'REVIEWER_1',
      rationale: 'Synthetic disposition only.',
    };
    await assert.rejects(
      one(
        f.db,
        'adj',
        adjudicateSql({ unit_id: kept.unit_id, ...adj, reason_code: 'BENIGN_NEOPLASM' }),
      ),
      /MU7-G47/,
    );
    await one(
      f.db,
      'adj',
      adjudicateSql({ unit_id: kept.unit_id, ...adj, reason_code: 'PRECANCEROUS' }),
    );
    await one(
      f.db,
      'adj',
      adjudicateSql({
        unit_id: removed.unit_id,
        ...adj,
        reason_code: 'NONMALIGNANT_NEOPLASM_STUDIED',
      }),
    );
    await one(f.db, 'inv', `select public.rpc_mu7_lock_reference('PILOT','${ATT}')`);
    const exp = {
      mode: 'PILOT',
      bundle_format_version: '8.3',
      row_counts: { units: 3, reviewer_guide: 1, judgment_history: 7, subtype_observations: 7 },
      file_sha256: {
        'reviewer_guide.md': RUBRIC,
        'judgment_history.csv': '2'.repeat(64),
        'subtype_observations.csv': '3'.repeat(64),
      },
      manifest_sha256: '4'.repeat(64),
      app_git_sha: 'e'.repeat(40),
    };
    const register = (v: unknown) =>
      one(f.db, 'inv', `select public.rpc_mu7_register_export(${literal(v)})`);
    await assert.rejects(register({ ...exp, bundle_format_version: '8.2' }), /MU81-P04/);
    await assert.rejects(
      register({ ...exp, row_counts: { ...exp.row_counts, reviewer_guide: 0 } }),
      /MU81-P05/,
    );
    await assert.rejects(
      register({ ...exp, row_counts: { ...exp.row_counts, judgment_history: 4 } }),
      /MU81-P05/,
    );
    await assert.rejects(
      register({
        ...exp,
        file_sha256: { ...exp.file_sha256, 'reviewer_guide.md': '0'.repeat(64) },
      }),
      /MU81-P05/,
    );
    const exportId = await register(exp);
    await one(
      f.db,
      'inv',
      phase('PILOT_SIGNED_OFF', {
        checklist_version: 'SYN-CHECKLIST',
        checklist_sha256: '5'.repeat(64),
        app_git_sha: 'e'.repeat(40),
        pilot_export_id: exportId,
      }),
    );
    assert.equal(await one(f.db, 'owner', 'select private.mu7_phase()'), 'SIGNED_OFF');
    // The formal sample identity digests are unchanged by the display-only profile.
    for (const unit of FORMAL_UNITS) {
      const imported = importObj(unit);
      imported.design.design_version = VERSION;
      if (unit.code.startsWith('K_KEEP_')) imported.packet.unit.display_text = KEEP;
      await one(f.db, 'inv', `select public.rpc_mu7_import_unit(${literal(imported)})`);
    }
    await assert.rejects(one(f.db, 'inv', freezeSql()), /MU7-G29|MU7X-G06/);
    assert.equal(
      await one(f.db, 'owner', 'select count(*)::int from public.mu7_gate_approvals'),
      0,
    );
    await specifyAndApproveGates(f.db, 'all'); // synthetic approvals confined to this disposable fixture
    await one(f.db, 'inv', freezeSql());
    const freeze = (
      await rows<Record<string, unknown>>(f.db, 'owner', 'select * from public.mu7_freeze')
    )[0];
    for (const [key, expected] of Object.entries(freezeHashes()))
      assert.equal(freeze[key], expected);
    assert.equal(
      freeze.reviewer_profile_sha256,
      ((await readProfile(f.db)) as { binding_sha256: string }).binding_sha256,
    );
  } finally {
    await f.db.close();
  }
});

test('original vocabulary remains byte-for-byte and reason-for-reason when no profile is bound', async () => {
  const f = await signedOffPilot({ designVersion: VERSION, stopAfter: 'design' });
  try {
    const vocab = JSON.parse(
      readFileSync('tests/handoff/fixtures/v7/VOCABULARY_CONTRACT_v7.json', 'utf8'),
    );
    for (const [key, value] of Object.entries(vocab.display_texts))
      assert.equal(
        await one(f.db, 'owner', 'select private.mu7_display_text($1,$2)', key.split('|')),
        value,
      );
    for (const [key, list] of Object.entries(vocab.reasons as Record<string, string[]>))
      for (const reason of vocab.all_reason_codes)
        assert.equal(
          await one(f.db, 'owner', 'select private.mu7_reason_ok($1,$2,$3)', [
            ...key.split('|'),
            reason,
          ]),
          list.includes(reason),
        );
    assert.equal(
      await one(
        f.db,
        'owner',
        "select private.mu7_reason_ok('SG','K_REMOVE_VERIFIED_NONMALIGNANT','NONMALIGNANT_NEOPLASM_STUDIED')",
      ),
      false,
    );
  } finally {
    await f.db.close();
  }
});

for (const designVersion of ['SYN-7-PROFILE-UPGRADE', VERSION])
  test(`0037 preserves existing ${designVersion} packets, judgments and locks`, async () => {
    const f = await signedOffPilot({ without: [MIGRATION], designVersion });
    try {
      const read = () =>
        Promise.all(
          [
            'mu7_units',
            'mu7_unit_design',
            'mu7_frozen_assignments',
            'mu7_judgments',
            'mu7_adjudications',
            'mu7_reference_locks',
            'mu7_design',
            'mu7_exports',
          ].map((t) =>
            rows(
              f.db,
              'owner',
              `select to_jsonb(x) as row from public.${t} x order by to_jsonb(x)::text`,
            ),
          ),
        );
      const before = await read();
      await f.db.exec(readFileSync(MIGRATION, 'utf8'));
      assert.deepEqual(await read(), before);
      assert.equal(await readProfile(f.db), null);
      await assert.rejects(one(f.db, 'inv', bindSql()), /MU81-P01|MU81-P02/);
      assert.equal(
        await one(
          f.db,
          'owner',
          "select private.mu7_display_text('SG','K_KEEP_MALIGNANT_COMPATIBLE')",
        ),
        'malignant neoplasm, counted in the Neoplasms row',
      );
      await assert.rejects(
        one(
          f.db,
          'inv',
          `select public.rpc_mu7_register_export(${literal({ mode: 'PILOT', bundle_format_version: '8.3', row_counts: { units: 12 }, file_sha256: {}, manifest_sha256: '7'.repeat(64), app_git_sha: 'e'.repeat(40) })})`,
        ),
        /MU81-G08/,
      );
    } finally {
      await f.db.close();
    }
  });

test('profile binding is refused under a repeatable-read snapshot', async () => {
  const f = await signedOffPilot({ designVersion: VERSION, stopAfter: 'design' });
  try {
    await as(f.db, 'inv', async () => {
      await f.db.exec('begin isolation level repeatable read');
      try {
        await assert.rejects(f.db.query(bindSql()), /MU81-P01/);
      } finally {
        await f.db.exec('rollback');
      }
    });
    assert.equal(await readProfile(f.db), null);
  } finally {
    await f.db.close();
  }
});

// The same statement must re-read the profile/activity after it waits on the lifecycle lock.
// PGlite cannot establish this; these two cases run on disposable native PostgreSQL in CI.
const baseUrl = process.env.VERIFY_PG_TEST_URL;
const nativeOptions = {
  skip:
    !baseUrl && process.env.VERIFY_PG_REQUIRE !== '1'
      ? 'BLOCKED: native PostgreSQL test server unavailable'
      : false,
  timeout: 120_000,
};
for (const first of ['binding', 'import'] as const)
  test(
    `native reviewer profile serializes against an in-flight ${first}`,
    nativeOptions,
    async () => {
      assert.ok(baseUrl, 'BLOCKED: VERIFY_PG_TEST_URL is required');
      await withDisposableHandoffDatabase(baseUrl, async (url: string) => {
        const [owner, binder, importer] = [0, 1, 2].map(
          () => new Client({ connectionString: url }),
        );
        let pending: Promise<{ error: Error | null }> | undefined;
        try {
          for (const c of [owner, binder, importer]) await c.connect();
          await signedOffPilot({
            designVersion: VERSION,
            stopAfter: 'design',
            existing: {
              exec: (sql) => owner.query(sql),
              query: async <T>(sql: string, params: unknown[] = []) => ({
                rows: (await owner.query(sql, params)).rows as T[],
              }),
            },
          });
          for (const c of [binder, importer]) {
            await c.query("select set_config('request.jwt.claims',$1,false)", [
              JSON.stringify(P.inv),
            ]);
            await c.query('set role authenticated');
          }
          const importSql = `select public.rpc_mu7_import_unit(${literal(first === 'binding' ? subset()[1] : INPUTS[0])})`;
          const leader = first === 'binding' ? binder : importer;
          const follower = first === 'binding' ? importer : binder;
          await leader.query('begin');
          await leader.query(first === 'binding' ? bindSql() : importSql);
          const pid = (await follower.query('select pg_backend_pid() as pid')).rows[0].pid;
          pending = follower.query(first === 'binding' ? importSql : bindSql()).then(
            () => ({ error: null }),
            (error: Error) => ({ error }),
          );
          let waiting = false;
          for (let n = 0; n < 150; n++) {
            if (
              (
                await owner.query('select wait_event_type from pg_stat_activity where pid=$1', [
                  pid,
                ])
              ).rows[0]?.wait_event_type === 'Lock'
            ) {
              waiting = true;
              break;
            }
            await delay(20);
          }
          assert.equal(waiting, true, 'operation waits for the other transaction');
          await leader.query('commit');
          const result = await pending;
          assert.ok(
            result.error,
            'the waiting operation must recheck the committed profile/activity',
          );
          assert.match(
            result.error.message,
            first === 'binding' ? /canonical|display/ : /MU81-P02/,
          );
          const n = (
            await owner.query(
              'select (select count(*) from public.mu7_units)::int as units,(select count(*) from public.mu7_reviewer_profile_v81)::int as profiles',
            )
          ).rows[0];
          assert.deepEqual(
            n,
            first === 'binding' ? { units: 0, profiles: 1 } : { units: 1, profiles: 0 },
          );
        } finally {
          // Release the leading transaction even when an assertion fails, then drain the waiter.
          await Promise.allSettled([binder.query('rollback'), importer.query('rollback')]);
          await pending;
          await Promise.allSettled([owner.end(), binder.end(), importer.end()]);
        }
      });
    },
  );
