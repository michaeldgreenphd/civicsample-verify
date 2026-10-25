// Hosted service orchestration only: all requests terminate in this in-process fake gateway.
// Database role policies and concurrency are exercised separately by the PostgreSQL suites.
import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import {
  MC_SYNTHETIC_PILOT_CASES,
  MC_SYNTHETIC_TRAINING_CASES,
} from '../src/lib/mapconf-synthetic';
import { MC_CONDITION_SET_ID, type McCaseInput } from '../src/lib/mapconf-types';
import { mcAdminAction } from '../src/server/mapconf-rest';
import type { SessionActor } from '../src/server/session';

const env = {
  VERIFY_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  VERIFY_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_test_000000',
  VERIFY_SITE_ORIGIN: 'http://127.0.0.1:3300',
};
const savedEnv = new Map<string, string | undefined>();
before(() => {
  for (const [key, value] of Object.entries(env)) {
    savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
});
after(() => {
  for (const [key, value] of savedEnv)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

const actor: SessionActor = {
  id: '00000000-0000-4000-8000-000000000101',
  displayName: 'Synthetic investigator',
  role: 'INVESTIGATOR',
  accessToken: 'synthetic-session-token',
  aal: 'aal2',
  mfaEnrolled: true,
};
type Row = Record<string, unknown>;
const fixtureRow = (x: McCaseInput): Row => ({
  case_id: x.caseId,
  record_category: x.recordCategory,
  trial_ref: x.trialRef,
  condition_code: x.conditionCode,
  condition_label: x.conditionLabel,
  condition_set_id: MC_CONDITION_SET_ID,
  assignment: structuredClone(x.assignment),
  evidence: structuredClone(x.evidence),
  evidence_version: 1,
  assignment_sha256: 'a'.repeat(64),
  evidence_sha256: 'b'.repeat(64),
  created_at: '2026-01-01T00:00:00Z',
});
const syntheticRows = () =>
  [...MC_SYNTHETIC_PILOT_CASES, ...MC_SYNTHETIC_TRAINING_CASES].map(fixtureRow);
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const account = (n: number, active = true, pilot = true): Row => ({
  user_id: uid(n),
  role: 'REVIEWER',
  is_active: active,
  is_pilot_test_account: pilot,
});
const reviewer = (n: number): Row => ({
  reviewer_pseudo_id: `SYN-R${n}`,
  user_id: uid(n),
  mode_scope: 'PILOT',
  withdrawn_at: null,
});

function gateway(t: TestContext) {
  const state = {
    cases: [] as Row[],
    users: [account(1), account(2)],
    reviewers: [reviewer(1), reviewer(2)],
    assignments: [] as Row[],
    calls: [] as { name: string; args: Row }[],
    importAttempts: 0,
    failImportAt: null as number | null,
    loseImportResponseAt: null as number | null,
    failAssignSlot: null as number | null,
  };
  const respond = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, env.VERIFY_SUPABASE_URL);
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${actor.accessToken}`);
    assert.equal(new Headers(init?.headers).get('apikey'), env.VERIFY_SUPABASE_PUBLISHABLE_KEY);
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.split('/').at(-1)!;
      const args = JSON.parse(String(init?.body)) as Row;
      state.calls.push({ name, args });
      if (name === 'rpc_mc_completion_summary') return respond([]);
      if (name === 'rpc_mc_import_case') {
        state.importAttempts++;
        if (state.failImportAt === state.importAttempts) return respond({}, 503);
        const row = args.p as Row;
        assert.ok(
          !state.cases.some((saved) => saved.case_id === row.case_id),
          'never reinsert a case',
        );
        state.cases.push(structuredClone({ ...row, evidence_version: 1 }));
        if (state.loseImportResponseAt === state.importAttempts) return respond({}, 503);
        return respond(row.case_id);
      }
      if (name === 'rpc_enroll_reviewer') {
        assert.ok(!state.reviewers.some((r) => r.user_id === args.p_user_id));
        state.reviewers.push({
          reviewer_pseudo_id: `SYN-ENROLLED-${state.reviewers.length}`,
          user_id: args.p_user_id,
          mode_scope: 'PILOT',
          withdrawn_at: null,
        });
        return respond(null);
      }
      if (name === 'rpc_mc_assign') {
        if (state.failAssignSlot === args.p_slot) {
          state.failAssignSlot = null;
          return respond({}, 503);
        }
        for (const caseId of args.p_case_ids as string[]) {
          assert.ok(
            !state.assignments.some((a) => a.case_id === caseId && a.reviewer_slot === args.p_slot),
          );
          state.assignments.push({
            case_id: caseId,
            reviewer_pseudo_id: args.p_reviewer_pseudo_id,
            reviewer_slot: args.p_slot,
            randomization_seed: args.p_seed,
          });
        }
        return respond((args.p_case_ids as string[]).length);
      }
      assert.fail(`Unexpected RPC ${name}`);
    }
    const table = url.pathname.split('/').at(-1);
    let rows: Row[];
    if (table === 'mc_cases') {
      rows = state.cases;
      const category = url.searchParams.get('record_category');
      if (category?.startsWith('eq.'))
        rows = rows.filter((r) => r.record_category === category.slice(3));
    } else if (table === 'users') {
      assert.equal(url.searchParams.get('is_active'), 'is.true');
      assert.equal(url.searchParams.get('is_pilot_test_account'), 'is.true');
      assert.equal(url.searchParams.get('role'), 'eq.REVIEWER');
      rows = state.users.filter(
        (u) => u.is_active && u.is_pilot_test_account && u.role === 'REVIEWER',
      );
    } else if (table === 'reviewers') {
      rows = state.reviewers.filter((r) => r.withdrawn_at === null);
      if (url.searchParams.get('mode_scope') === 'eq.PILOT')
        rows = rows.filter((r) => r.mode_scope === 'PILOT');
    } else if (table === 'mc_assignments') rows = state.assignments;
    else if (
      ['mc_campaign', 'mc_campaign_events', 'mc_exports', 'mc_adjudications'].includes(table ?? '')
    )
      rows = [];
    else assert.fail(`Unexpected table ${table}`);
    const columns = url.searchParams.get('select')!.split(',');
    const projected = rows.map((row) =>
      Object.fromEntries(columns.map((column) => [column, row[column]])),
    );
    return respond(projected.slice(0, Number(url.searchParams.get('limit') ?? projected.length)));
  });
  return state;
}
const mutations = (state: ReturnType<typeof gateway>) =>
  state.calls.filter((c) => c.name !== 'rpc_mc_completion_summary');

test('hosted synthetic import resumes after interruption and completed retry writes nothing', async (t) => {
  const state = gateway(t);
  state.failImportAt = 4;
  await assert.rejects(mcAdminAction(actor, { action: 'import-synthetic' }), { status: 502 });
  assert.equal(state.cases.length, 3);
  const preserved = structuredClone(state.cases);
  const result = await mcAdminAction(actor, { action: 'import-synthetic' });
  assert.deepEqual(state.cases.slice(0, 3), preserved);
  assert.equal(result.counts.syntheticPilot, 12);
  assert.equal(result.counts.trainingExample, 3);
  assert.equal(state.cases.length, 15);
  const count = mutations(state).length;
  await mcAdminAction(actor, { action: 'import-synthetic' });
  assert.equal(mutations(state).length, count);
});

test('hosted synthetic import recovers when a committed import loses its response', async (t) => {
  const state = gateway(t);
  state.loseImportResponseAt = 3;
  await assert.rejects(mcAdminAction(actor, { action: 'import-synthetic' }), { status: 502 });
  assert.equal(state.cases.length, 3);
  await mcAdminAction(actor, { action: 'import-synthetic' });
  assert.equal(state.cases.length, 15);
  assert.equal(state.importAttempts, 15);
});

test('hosted synthetic import refuses changed fields before adding any missing packet', async (t) => {
  const changes: Row[] = [
    { condition_set_id: 'SYN-DIFFERENT-SET' },
    { record_category: 'EVALUATION' },
    { trial_ref: 'SYN-NCT-9999' },
    { condition_label: 'Synthetic changed label' },
    { assignment: { ...MC_SYNTHETIC_PILOT_CASES[0].assignment, assigned: false } },
    { evidence: { ...MC_SYNTHETIC_PILOT_CASES[0].evidence, brief_summary: { present: false } } },
    { evidence_version: 2 },
  ];
  for (const change of changes)
    await t.test(Object.keys(change)[0], async (child) => {
      const state = gateway(child);
      state.cases = [{ ...fixtureRow(MC_SYNTHETIC_PILOT_CASES[0]), ...change }];
      const preserved = structuredClone(state.cases);
      await assert.rejects(mcAdminAction(actor, { action: 'import-synthetic' }), { status: 409 });
      assert.deepEqual(state.cases, preserved);
      assert.deepEqual(mutations(state), []);
    });
});

test('hosted synthetic import refuses an unexpected saved case and tolerates JSON key order', async (t) => {
  const state = gateway(t);
  const fixture = fixtureRow(MC_SYNTHETIC_PILOT_CASES[0]);
  fixture.evidence = Object.fromEntries(Object.entries(fixture.evidence as Row).reverse());
  state.cases = [fixture, { ...fixtureRow(MC_SYNTHETIC_PILOT_CASES[1]), case_id: 'MC-SYN-EXTRA' }];
  await assert.rejects(mcAdminAction(actor, { action: 'import-synthetic' }), { status: 409 });
  assert.deepEqual(mutations(state), []);
  state.cases.pop();
  await mcAdminAction(actor, { action: 'import-synthetic' });
  assert.equal(state.cases.length, 15);
});

test('hosted pilot assignment excludes inactive and non-pilot enrolled reviewers', async (t) => {
  const state = gateway(t);
  state.cases = syntheticRows();
  state.users.unshift(account(3, false), account(4, true, false));
  state.reviewers.unshift(reviewer(3), reviewer(4));
  await mcAdminAction(actor, { action: 'assign', seed: 7 });
  assert.equal(state.assignments.length, 24);
  assert.deepEqual(
    [...new Set(state.assignments.map((a) => a.reviewer_pseudo_id))],
    ['SYN-R1', 'SYN-R2'],
  );
});

test('hosted pilot assignment requires two distinct active eligible accounts before writing', async (t) => {
  const state = gateway(t);
  state.cases = syntheticRows();
  state.users = [account(1), account(1), account(2, false)];
  await assert.rejects(mcAdminAction(actor, { action: 'assign', seed: 7 }), { status: 409 });
  assert.deepEqual(mutations(state), []);
});

test('hosted pilot assignment enrolls only the two eligible accounts selected for empty slots', async (t) => {
  const state = gateway(t);
  state.cases = syntheticRows();
  state.users = [account(3, false), account(1), account(2)];
  state.reviewers = [reviewer(3)];
  await mcAdminAction(actor, { action: 'assign', seed: 7 });
  const enrollments = mutations(state).filter((call) => call.name === 'rpc_enroll_reviewer');
  assert.deepEqual(
    enrollments.map((call) => call.args.p_user_id),
    [uid(1), uid(2)],
  );
  assert.equal(state.assignments.length, 24);
  assert.ok(state.assignments.every((row) => row.reviewer_pseudo_id !== 'SYN-R3'));
});

test('hosted pilot assignment resumes without swapping slots or rewriting assignments', async (t) => {
  const state = gateway(t);
  state.cases = syntheticRows();
  state.failAssignSlot = 2;
  await assert.rejects(mcAdminAction(actor, { action: 'assign', seed: 7 }), { status: 502 });
  assert.equal(state.assignments.length, 12);
  const preserved = structuredClone(state.assignments);
  state.users.reverse();
  await mcAdminAction(actor, { action: 'assign', seed: 7 });
  assert.equal(state.assignments.length, 24);
  assert.deepEqual(state.assignments.slice(0, 12), preserved);
  assert.ok(
    state.assignments
      .filter((a) => a.reviewer_slot === 2)
      .every((a) => a.reviewer_pseudo_id === 'SYN-R2'),
  );
  const count = mutations(state).length;
  await mcAdminAction(actor, { action: 'assign', seed: 7 });
  assert.equal(mutations(state).length, count);
});

test('hosted pilot assignment refuses inactive historical reviewers and changed seeds', async (t) => {
  const state = gateway(t);
  state.cases = syntheticRows();
  state.assignments = [
    {
      case_id: MC_SYNTHETIC_PILOT_CASES[0].caseId,
      reviewer_pseudo_id: 'SYN-R1',
      reviewer_slot: 1,
      randomization_seed: 7,
    },
  ];
  const preserved = structuredClone(state.assignments);
  state.users = [account(1, false), account(2), account(3)];
  await assert.rejects(mcAdminAction(actor, { action: 'assign', seed: 7 }), { status: 409 });
  state.users = [account(1), account(2)];
  await assert.rejects(mcAdminAction(actor, { action: 'assign', seed: 8 }), { status: 409 });
  assert.deepEqual(state.assignments, preserved);
  assert.deepEqual(mutations(state), []);
});

test('hosted pilot assignment refuses inconsistent existing slots instead of silently adding a third reviewer', async (t) => {
  const state = gateway(t);
  state.cases = syntheticRows();
  state.users.push(account(3));
  state.reviewers.push(reviewer(3));
  state.assignments = [
    {
      case_id: MC_SYNTHETIC_PILOT_CASES[0].caseId,
      reviewer_pseudo_id: 'SYN-R1',
      reviewer_slot: 1,
      randomization_seed: 7,
    },
    {
      case_id: MC_SYNTHETIC_PILOT_CASES[1].caseId,
      reviewer_pseudo_id: 'SYN-R3',
      reviewer_slot: 1,
      randomization_seed: 7,
    },
  ];
  const preserved = structuredClone(state.assignments);
  await assert.rejects(mcAdminAction(actor, { action: 'assign', seed: 7 }), { status: 409 });
  assert.deepEqual(state.assignments, preserved);
  assert.deepEqual(mutations(state), []);
});
