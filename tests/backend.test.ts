import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdjudicationInput, JudgmentInput } from '../src/lib/types';
import { DEMO_ACTORS, getDb, withActor } from '../src/server/db';
import {
  adjudicate,
  adminAction,
  getCase,
  getExportData,
  getWorkspace,
  saveDraft,
  ServiceError,
  submitReview,
  submitStep1,
} from '../src/server/service';

process.env.VERIFY_DB_DIR = 'memory';
const [investigator, a, b, adjudicator] = DEMO_ACTORS;
const input: JudgmentInput = {
  decision: 'INCLUDE',
  rationale: 'Fictional rationale for testing the workflow.',
  uncertain: false,
  context: '',
  packetProblem: false,
};
const context = JSON.stringify({
  clinicalContext: 'Fictional clinical context.',
  inclusionConditions: 'Include when studying the fictional disease.',
  exclusionConditions: 'Exclude when incidental to the fictional trial.',
});
const invalidContexts = [
  'x',
  '{}',
  'null',
  '[]',
  JSON.stringify({ clinicalContext: 'x', inclusionConditions: ' \t\n', exclusionConditions: 'x' }),
  JSON.stringify({ clinicalContext: 'x', inclusionConditions: 'x', exclusionConditions: false }),
];
const adjudicationInput: AdjudicationInput = {
  ...input,
  status: 'RESOLVED',
  basis: 'Both independent synthetic reviews and the frozen fictional packet.',
  reasonCode: 'OTHER',
  level: 'DESCRIPTOR_LEVEL',
  uncertain: true,
  context: 'Adjudicator context remains preserved.',
  packetProblem: true,
  packetProblemNote: 'Fictional packet issue.',
};
async function denied(action: Promise<unknown>, status?: number) {
  await assert.rejects(
    action,
    (error: unknown) => error instanceof ServiceError && (!status || error.status === status),
  );
}
after(async () => {
  await (await getDb()).close();
});

test('synthetic lifecycle enforces independent blinding, final locks, amendments, authorization and export integrity', async () => {
  const db = await getDb();
  assert.deepEqual(
    (
      await db.query<{ version: string }>(
        'select version from public.app_schema_version order by applied_at',
      )
    ).rows.map((r) => r.version),
    ['1.0.0', '3.0.0', '4.0.0', '4.0.1-synthetic', '4.0.2-review-integrity'],
  );
  const initialAdmin = await getWorkspace(investigator);
  assert.equal(initialAdmin.configuration.tierVersion, 'PENDING');
  assert.ok(
    ['sample', 'coverage', 'tier', 'rubric', 'reviewers', 'security', 'pilot'].every((id) =>
      initialAdmin.gates.some((gate) => gate.id === id),
    ),
  );
  assert.equal(initialAdmin.gates.find((gate) => gate.id === 'coverage')?.state, 'BLOCKED');
  const wa = await getWorkspace(a);
  const wb = await getWorkspace(b);
  assert.equal(wa.queue.length, 10);
  assert.deepEqual(new Set(wa.queue.map((c) => c.caseId)), new Set(wb.queue.map((c) => c.caseId)));
  assert.notDeepEqual(
    wa.queue.map((c) => c.caseId),
    wb.queue.map((c) => c.caseId),
  );
  assert.equal((await getWorkspace(adjudicator)).queue.length, 0);
  await denied(getCase(adjudicator, 'SYN-001'), 409);
  await denied(getCase(investigator, 'SYN-001'), 403);
  await denied(getExportData(investigator), 409);
  await denied(adminAction(investigator, { action: 'activate-formal' }), 403);
  await denied(
    adminAction(a, { action: 'configure', configuration: { tierVersion: 'v1.2' } }),
    403,
  );
  await denied(
    adminAction(investigator, { action: 'configure', configuration: { tierState: 'APPROVED' } }),
    400,
  );
  await adminAction(investigator, { action: 'configure', configuration: { tierVersion: 'v1.2' } });
  assert.equal((await getWorkspace(a)).configuration.tierVersion, 'PENDING');
  await denied(
    adminAction(investigator, { action: 'close', attestation: 'Explicit synthetic review close.' }),
    409,
  );
  await denied(adjudicate(adjudicator, 'SYN-001', adjudicationInput), 409);

  // Trial data is denied at the database boundary, not merely hidden by JSX.
  const rawTrialBefore = await withActor(a, (tx) =>
    tx.query<{ packet: Record<string, unknown> }>(
      "select public.rpc_verify_case('SYN-009') as packet",
    ),
  );
  assert.equal('trialPacket' in rawTrialBefore.rows[0].packet, false);
  await assert.rejects(
    withActor(a, (tx) =>
      tx.query("select trial_packet from public.verify_cases where id='SYN-009'"),
    ),
    /permission denied/,
  );
  await denied(submitReview(a, 'SYN-009', { ...input, descriptorRole: 'DISEASE_STUDIED' }), 409);
  await denied(submitStep1(a, 'SYN-009', { ...input, rationale: ' ' }), 400);
  for (const invalid of invalidContexts) {
    await denied(
      submitStep1(a, 'SYN-009', { ...input, decision: 'CONTEXT_DEPENDENT', context: invalid }),
      400,
    );
    await assert.rejects(
      withActor(a, (tx) =>
        tx.query(
          "select public.rpc_verify_submit('SYN-009','DESCRIPTOR_LEVEL_IN_TRIAL_CASE',$1::jsonb)",
          [JSON.stringify({ ...input, decision: 'CONTEXT_DEPENDENT', context: invalid })],
        ),
      ),
      /Structured context is required/,
    );
  }
  const step1 = await submitStep1(a, 'SYN-009', {
    ...input,
    decision: 'CONTEXT_DEPENDENT',
    context,
  });
  assert.equal(step1.step1Locked, true);
  assert.ok(step1.trialPacket);
  assert.equal((await getCase(b, 'SYN-009')).trialPacket, undefined);
  await denied(submitStep1(a, 'SYN-009', input), 409);
  await denied(submitReview(a, 'SYN-009', input), 400);
  await submitReview(a, 'SYN-009', { ...input, descriptorRole: 'DISEASE_STUDIED' });

  await saveDraft(a, 'SYN-001', { ...input, rationale: '' });
  assert.equal((await getCase(a, 'SYN-001')).draft?.rationale, '');
  assert.equal((await getCase(b, 'SYN-001')).draft, undefined);
  await submitReview(a, 'SYN-001', input);
  await denied(saveDraft(a, 'SYN-001', input), 409);
  await denied(submitReview(a, 'SYN-001', input), 409);
  await denied(submitReview(a, 'SYN-002', { ...input, packetProblem: true }), 400);
  await assert.rejects(
    withActor(a, (tx) =>
      tx.query("select public.rpc_verify_submit('SYN-002','DESCRIPTOR_LEVEL',$1::jsonb)", [
        JSON.stringify({ ...input, rationale: '' }),
      ]),
    ),
    /check constraint/,
  );
  const bRows = await withActor(b, (tx) => tx.query('select * from public.verify_responses'));
  assert.equal(bRows.rows.length, 0);
  const investigatorRows = await withActor(investigator, (tx) =>
    tx.query('select * from public.verify_responses'),
  );
  assert.equal(investigatorRows.rows.length, 0);
  const adjudicatorRows = await withActor(adjudicator, (tx) =>
    tx.query('select * from public.verify_responses'),
  );
  assert.equal(adjudicatorRows.rows.length, 0);
  const progress = await getWorkspace(investigator);
  assert.equal(progress.campaign.completed, 2);
  assert.equal(JSON.stringify(progress).includes(input.rationale), false);
  const audit = await withActor(investigator, (tx) =>
    tx.query('select details from public.verify_audit'),
  );
  assert.equal(JSON.stringify(audit.rows).includes(input.rationale), false);

  // Authorization and resubmission append a version. Originals cannot change.
  await adminAction(investigator, {
    action: 'authorize-amendment',
    caseId: 'SYN-001',
    reviewerId: a.id,
    level: 'DESCRIPTOR_LEVEL',
    reason: 'Explicit synthetic correction authorization.',
    attestation: 'Authorize this documented synthetic amendment.',
  });
  const amendment = (await getCase(a, 'SYN-001')).availableAmendments?.[0];
  assert.ok(amendment);
  await denied(submitReview(b, 'SYN-001', { ...input, amendmentId: amendment.id }), 409);
  await adminAction(investigator, {
    action: 'authorize-amendment',
    caseId: 'SYN-001',
    reviewerId: a.id,
    level: 'DESCRIPTOR_LEVEL',
    reason: 'Second separately scoped fictional amendment.',
    attestation: 'Authorize a second auditable amendment.',
  });
  const otherAmendment = (await getCase(a, 'SYN-001')).availableAmendments?.find(
    (candidate) => candidate.id !== amendment.id,
  );
  assert.ok(otherAmendment);
  // Incomplete context can be a draft; it cannot become a final answer.
  await saveDraft(a, 'SYN-001', {
    ...input,
    decision: 'CONTEXT_DEPENDENT',
    context: 'partial',
    amendmentId: amendment.id,
    level: 'DESCRIPTOR_LEVEL',
  });
  await saveDraft(a, 'SYN-001', {
    ...input,
    rationale: 'Second amendment draft.',
    amendmentId: otherAmendment.id,
    level: 'DESCRIPTOR_LEVEL',
  });
  const draftState = await getCase(a, 'SYN-001');
  assert.equal(draftState.drafts?.length, 2);
  assert.equal(draftState.submission?.decision, 'INCLUDE');
  assert.equal(draftState.submission?.version, 1);
  assert.equal(draftState.drafts?.find((d) => d.amendmentId === amendment.id)?.context, 'partial');
  await denied(saveDraft(a, 'SYN-001', input), 409);
  await denied(saveDraft(b, 'SYN-001', { ...input, amendmentId: amendment.id }), 409);
  await denied(saveDraft(a, 'SYN-002', { ...input, amendmentId: amendment.id }), 409);
  await assert.rejects(
    withActor(a, (tx) =>
      tx.query("select public.rpc_verify_draft('SYN-001','TRIAL_LEVEL',$1::jsonb)", [
        JSON.stringify({ ...input, amendmentId: amendment.id }),
      ]),
    ),
    /Amendment does not authorize|Initial response cannot/,
  );
  await denied(
    submitReview(a, 'SYN-001', {
      ...input,
      decision: 'CONTEXT_DEPENDENT',
      context: 'partial',
      amendmentId: amendment.id,
    }),
    400,
  );
  const amended = await submitReview(a, 'SYN-001', {
    ...input,
    decision: 'EXCLUDE',
    rationale: 'A revised fictional rationale.',
    amendmentId: amendment.id,
  });
  assert.equal(amended.submission?.version, 2);
  assert.equal(amended.submission?.decision, 'EXCLUDE');
  assert.equal(amended.availableAmendments?.length, 1);
  assert.equal(amended.drafts?.length, 1);
  assert.equal(amended.drafts?.[0].amendmentId, otherAmendment.id);
  await denied(saveDraft(a, 'SYN-001', { ...input, amendmentId: amendment.id }), 409);
  const secondAmended = await submitReview(a, 'SYN-001', {
    ...input,
    decision: 'EXCLUDE',
    amendmentId: otherAmendment.id,
  });
  assert.equal(secondAmended.submission?.version, 3);
  assert.equal(secondAmended.availableAmendments?.length, 0);
  assert.equal(secondAmended.drafts?.length, 0);
  await denied(submitReview(a, 'SYN-001', { ...input, amendmentId: amendment.id }), 409);
  await assert.rejects(
    db.exec("update public.verify_responses set decision='INCLUDE'"),
    /append.only|immutable|not allowed|cannot/i,
  );
  await assert.rejects(
    withActor(a, (tx) => tx.query('delete from public.verify_responses')),
    /permission denied/,
  );

  for (const actor of [a, b]) {
    for (const item of (await getWorkspace(actor)).queue) {
      const detail = await getCase(actor, item.caseId);
      if (detail.submission) continue;
      if (detail.step1Required && !detail.step1Locked)
        await submitStep1(actor, item.caseId, { ...input, decision: 'CONTEXT_DEPENDENT', context });
      await submitReview(
        actor,
        item.caseId,
        detail.step1Required
          ? { ...input, descriptorRole: 'DISEASE_STUDIED' }
          : item.caseId === 'SYN-004' && actor.id === b.id
            ? { ...input, decision: 'INSUFFICIENT_INFORMATION' }
            : input,
      );
    }
  }
  assert.equal((await getWorkspace(investigator)).campaign.completed, 20);
  await denied(
    adminAction(investigator, {
      action: 'authorize-adjudication',
      attestation: 'Authorize fictional adjudication.',
    }),
    409,
  );
  await adminAction(investigator, {
    action: 'close',
    attestation: 'All fictional independent judgments are complete.',
  });
  assert.equal((await getWorkspace(adjudicator)).queue.length, 0);
  await denied(adjudicate(adjudicator, 'SYN-001', adjudicationInput), 409);
  await denied(submitReview(a, 'SYN-002', input), 409);
  await denied(
    adminAction(investigator, {
      action: 'authorize-amendment',
      caseId: 'SYN-001',
      reviewerId: a.id,
      level: 'DESCRIPTOR_LEVEL',
      reason: 'Too late.',
      attestation: 'Too late synthetic amendment.',
    }),
    409,
  );
  await adminAction(investigator, {
    action: 'authorize-adjudication',
    attestation: 'Authorize blinded adjudication of the complete snapshot.',
  });
  assert.equal((await getWorkspace(adjudicator)).queue.length, 10);
  const caseOne = await getCase(adjudicator, 'SYN-001');
  assert.equal(caseOne.humanReviews?.length, 2);
  assert.equal(caseOne.humanReviews?.find((r) => r.reviewerSlot === 'A')?.decision, 'EXCLUDE');
  await denied(adjudicate(investigator, 'SYN-001', adjudicationInput), 403);
  await denied(
    adminAction(investigator, { action: 'lock', attestation: 'Try premature lock.' }),
    409,
  );
  for (const invalid of invalidContexts) {
    await denied(
      adjudicate(adjudicator, 'SYN-001', {
        ...adjudicationInput,
        decision: 'CONTEXT_DEPENDENT',
        context: invalid,
      }),
      400,
    );
    await assert.rejects(
      withActor(adjudicator, (tx) =>
        tx.query("select public.rpc_verify_adjudicate('SYN-001','DESCRIPTOR_LEVEL',$1::jsonb)", [
          JSON.stringify({ ...adjudicationInput, decision: 'CONTEXT_DEPENDENT', context: invalid }),
        ]),
      ),
      /Structured context is required/,
    );
  }
  for (const item of (await getWorkspace(adjudicator)).queue) {
    const levels =
      item.unitType === 'TRIAL_AREA'
        ? ['DESCRIPTOR_LEVEL_IN_TRIAL_CASE', 'TRIAL_LEVEL']
        : ['DESCRIPTOR_LEVEL'];
    for (const determination of levels)
      await adjudicate(adjudicator, item.caseId, {
        ...adjudicationInput,
        level: determination,
        ...(item.caseId === 'SYN-002' ? { decision: 'CONTEXT_DEPENDENT', context } : {}),
        ...(item.caseId === 'SYN-003'
          ? { decision: null, status: 'UNRESOLVED_ESCALATED', context: '' }
          : {}),
      });
  }
  await denied(adjudicate(adjudicator, 'SYN-001', adjudicationInput), 409);
  await denied(getExportData(adjudicator), 403);
  await adminAction(investigator, {
    action: 'lock',
    attestation: 'Lock the completed fictional reference.',
  });
  await denied(adjudicate(adjudicator, 'SYN-001', adjudicationInput), 409);
  const exported = await getExportData(investigator);
  assert.equal(exported.campaign.state, 'LOCKED');
  assert.equal(exported.judgments.length, 26); // 12 levels × 2 reviewers + two preserved amendments.
  assert.equal(exported.adjudications.length, 12);
  assert.equal(
    exported.adjudications.find((r) => r.caseId === 'SYN-002')?.decision,
    'CONTEXT_DEPENDENT',
  );
  assert.equal(exported.adjudications.find((r) => r.caseId === 'SYN-002')?.context, context);
  assert.equal(exported.adjudications.find((r) => r.caseId === 'SYN-003')?.decision, null);
  assert.equal(
    exported.judgments.find((r) => r.caseId === 'SYN-004' && r.reviewerSlot === 'B')?.decision,
    'INSUFFICIENT_INFORMATION',
  );
  assert.equal(
    exported.judgments.find((r) => r.caseId === 'SYN-004' && r.reviewerSlot === 'B')?.context,
    '',
  );
  assert.equal(
    exported.adjudications.find((r) => r.caseId === 'SYN-003')?.status,
    'UNRESOLVED_ESCALATED',
  );
  assert.equal(exported.adjudications[0].uncertain, true);
  assert.equal(exported.adjudications[0].context, adjudicationInput.context);
  assert.equal(exported.adjudications[0].packetProblem, true);
  assert.equal(exported.adjudications[0].packetProblemNote, adjudicationInput.packetProblemNote);
  assert.equal(
    exported.judgments.filter((r) => r.caseId === 'SYN-001' && r.reviewerSlot === 'A').length,
    3,
  );
  assert.equal(exported.provenance.judgmentSnapshotHash.length, 64);
  assert.equal(exported.provenance.schemaVersion, '4.0.2-review-integrity');
  assert.equal(exported.configuration.analysisPlanState, 'PROPOSED');
  assert.equal(exported.provenance.analysisPlan, 'PENDING_APPROVAL');
  const storedSnapshot = (
    await db.query<{ snapshot_hash: string }>('select snapshot_hash from public.verify_state')
  ).rows[0].snapshot_hash;
  await db.query('update public.verify_state set snapshot_hash=$1', ['0'.repeat(64)]);
  await denied(getExportData(investigator), 409);
  await db.query('update public.verify_state set snapshot_hash=$1', [storedSnapshot]);
});

test('unauthenticated and forged-role access cannot inherit another request identity', async () => {
  await assert.rejects(
    withActor({ ...a, role: 'INVESTIGATOR' }, (tx) =>
      tx.query('select public.rpc_verify_export()'),
    ),
    /role mismatch/,
  );
  await assert.rejects(
    withActor({ ...a, id: '00000000-0000-4000-8000-000000000099' }, (tx) =>
      tx.query('select public.rpc_verify_workspace()'),
    ),
    /role mismatch/,
  );
  const results = await Promise.all(
    [a, b, investigator, adjudicator].map((actor) =>
      withActor(actor, (tx) =>
        tx.query<{ user_id: string }>('select private.app_user_id() as user_id'),
      ),
    ),
  );
  assert.deepEqual(
    results.map((r) => r.rows[0].user_id),
    DEMO_ACTORS.slice(1, 3)
      .concat([investigator, adjudicator])
      .map((r) => r.id),
  );
  const db = await getDb();
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.exec('set local role anon');
      await tx.query('select public.rpc_verify_workspace()');
    }),
    /permission denied/,
  );
});

test('on-disk pilot survives a process restart without losing drafts or reseeding cases', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const directory = await mkdtemp(join(tmpdir(), 'verify-persistence-'));
  const env = { ...process.env, VERIFY_DB_DIR: directory };
  try {
    const write = `import {getDb,DEMO_ACTORS} from './src/server/db.ts'; import {saveDraft} from './src/server/service.ts'; await saveDraft(DEMO_ACTORS[1],'SYN-003',${JSON.stringify({ ...input, rationale: 'Persisted fictional draft.' })}); await (await getDb()).close();`;
    await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', write], {
      cwd: process.cwd(),
      env,
    });
    const read = `import {getDb,DEMO_ACTORS} from './src/server/db.ts'; import {getCase,getWorkspace} from './src/server/service.ts'; console.log(JSON.stringify({rationale:(await getCase(DEMO_ACTORS[1],'SYN-003')).draft.rationale,cases:(await getWorkspace(DEMO_ACTORS[1])).queue.length})); await (await getDb()).close();`;
    const result = await run(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', read],
      { cwd: process.cwd(), env },
    );
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      rationale: 'Persisted fictional draft.',
      cases: 10,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('supplied schema, migrations and local auth shim remain byte-identical to the inspected handoff', async () => {
  const { createHash } = await import('node:crypto');
  const { readFile } = await import('node:fs/promises');
  // These are public implementation-file digests, not study artifact hashes.
  const expected = {
    'schema.sql': 'ed52f666e125e86e951b589d2b432e3b411a6c018751b74b9181fa3c3b72fda1',
    'migrations/0002_v3_review_design.sql':
      '022ec5415775524ad3b4f6a4190fef6d5a85ccc140be98ae3c654b148b90821e',
    'migrations/0003_v4_record_categories_module_b.sql':
      '66822b00bb8ac079364e02bd8adf19d8f9812d1541fee1325cdcf0c520d35f67',
    'supabase_test_shim/auth_shim.sql':
      '8118d22ded570779970c873fe675ab1b07eb77ff49db06b3eebb746caa25e5ed',
  };
  for (const [filename, sha256] of Object.entries(expected)) {
    assert.equal(
      createHash('sha256')
        .update(await readFile(filename))
        .digest('hex'),
      sha256,
      `${filename} must remain unchanged; append a new migration`,
    );
  }
});
