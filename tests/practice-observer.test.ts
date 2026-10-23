import assert from 'node:assert/strict';
import test from 'node:test';
import { signedOffPilot, one, rows, P } from './mu7-fixture';
import { MU7_SYNTHETIC_TRAINING } from '../src/lib/mu7-synthetic';
import { observerRequestAllowed } from '../src/lib/practice-observer';

test('practice observer has completion counts without MFA but no investigator powers even with MFA', async () => {
  const { db } = await signedOffPilot({ stopAfter: 'pilotAnswers' });
  try {
    for (const packet of MU7_SYNTHETIC_TRAINING)
      await one(db, 'inv', 'select public.rpc_mu7_import_training_unit($1::jsonb)', [
        JSON.stringify(packet),
      ]);
    await db.query('update public.users set practice_read_only=true where auth_uid=$1', [
      P.inv.sub,
    ]);
    for (const who of ['inv1', 'inv'] as const) {
      assert.equal(await one(db, who, 'select private.is_investigator()'), false);
      assert.equal(await one(db, who, 'select private.app_role()'), 'PRACTICE_OBSERVER');
      const w = (await one(db, who, 'select public.rpc_practice_observer_workspace()')) as {
        pilotUnits: number;
        training: unknown[];
        completion: { assigned: number; answered: number }[];
      };
      assert.equal(w.pilotUnits, 12);
      assert.equal(w.training.length, 3);
      assert.equal(w.completion.length, 2);
      assert.ok(w.completion.every((r) => r.assigned === 12 && r.answered === 12));
      for (const relation of [
        'mu7_judgments',
        'mu7_queue',
        'mu7_adjudications',
        'mu7_gate_approvals',
        'audit_log',
        'v_mu7_final_reference',
      ])
        assert.deepEqual(await rows(db, who, `select * from public.${relation}`), [], relation);
      for (const sql of [
        "select public.rpc_mu7_record_design('{}'::jsonb)",
        "select public.rpc_mu7_import_unit('{}'::jsonb)",
        "select public.rpc_mu7_assign_queue('PILOT','{}'::jsonb)",
        "select public.rpc_mu7_lock_reference('PILOT','Synthetic refusal test only')",
        "select public.rpc_mu7_phase('FORMAL_CLOSE','{}'::jsonb)",
        "select public.rpc_mu7_import_training_unit('{}'::jsonb)",
        "select public.rpc_register_user('refused@example.test','Refused','INVESTIGATOR',false)",
      ])
        await assert.rejects(one(db, who, sql), /investigator/i, sql);
      await assert.rejects(
        one(db, who, 'update public.users set practice_read_only=false'),
        /permission|policy/i,
      );
    }
    for (const who of ['pt1', 'pt2', 'adj', 'out'] as const)
      await assert.rejects(
        one(db, who, 'select public.rpc_practice_observer_workspace()'),
        /observer access/i,
      );
    assert.equal(
      await one(
        db,
        'owner',
        "select count(*) from public.audit_log where action='PRACTICE_ACCESS_CHANGED'",
      ),
      1,
    );
    await db.query(
      "insert into public.account_locks(user_id,locked_by,reason) select user_id,'synthetic owner','test observer lock' from public.users where auth_uid=$1",
      [P.inv.sub],
    );
    await assert.rejects(
      one(db, 'inv1', 'select public.rpc_practice_observer_workspace()'),
      /observer access/i,
    );
    await db.query(
      "update public.account_locks set released_at=now(),released_by='synthetic owner' where released_at is null",
    );
    await db.query('update public.users set practice_read_only=false where auth_uid=$1', [
      P.inv.sub,
    ]);
    assert.equal(await one(db, 'inv', 'select private.is_investigator()'), true);
    assert.equal(
      await one(db, 'inv1', 'select private.is_investigator()'),
      false,
      'full investigators still need MFA',
    );
  } finally {
    await db.close();
  }
});

test('observer route allowlist refuses edits, exports and all other workflows', () => {
  assert.equal(observerRequestAllowed('GET', '/api/practice-observer'), true);
  for (const method of ['GET', 'POST', 'DELETE', 'PATCH'])
    for (const path of [
      '/api/mu7/admin/action',
      '/api/mu7/admin/export/PILOT',
      '/api/mu7/workspace',
      '/api/mu7/adjudicate',
      '/api/mfa/enroll',
      '/api/mc/admin/action',
      '/api/admin/export',
    ])
      assert.equal(observerRequestAllowed(method, path), false);
  assert.equal(observerRequestAllowed('POST', '/api/practice-observer'), false);
});
