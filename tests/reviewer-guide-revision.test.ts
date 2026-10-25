import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  MU81_REVIEWER_PROFILES,
  MU81_REVIEWER_PROFILE_ID,
  MU81_REVIEWER_GUIDE_SHA256,
} from '../src/lib/mu81-reviewer-profile';
import { readReviewerProfile, reviewerGuideText } from '../src/server/mu81-reviewer-profile';
import { mu7SqlData } from '../src/server/mu7';
import { readMu7Bundle } from '../src/server/mu7-core';
import { ATT, as, one, rows, signedOffPilot } from './mu7-fixture';

const MIGRATION = 'migrations/0038_v81_reviewer_guide_r4.sql';

test('revision 4 changes only the requested heading and revision label', () => {
  const before = reviewerGuideText('mu81-plain-language-r3');
  assert.equal(
    reviewerGuideText(),
    before
      .replace('Guide revision 3 ·', 'Guide revision 4 ·')
      .replace(
        '## 2. Understand the question on the screen',
        '## 2. Different things you are judging',
      ),
  );
});

test('0038 preserves an answered, locked revision 3 pilot and its exact exported guide', async () => {
  const f = await signedOffPilot({
    designVersion: 'SYN-8-1-GUIDE-UPGRADE',
    reviewerProfile: 'mu81-plain-language-r3',
    without: [MIGRATION],
  });
  const data = mu7SqlData({ query: (q, p) => f.db.query(q, p) });
  const snapshot = () =>
    Promise.all(
      [
        'mu7_design',
        'mu7_units',
        'mu7_unit_design',
        'mu7_queue',
        'mu7_judgments',
        'mu7_adjudications',
        'mu7_reference_locks',
        'mu7_exports',
        'mu7_reviewer_profile_v81',
        'mu7_gate_requirements',
        'mu7_gate_approvals',
      ].map((t) =>
        rows(
          f.db,
          'owner',
          `select to_jsonb(x) as row from public.${t} x order by to_jsonb(x)::text`,
        ),
      ),
    );
  try {
    const before = await snapshot();
    const bundle = await as(f.db, 'inv', () => readMu7Bundle(data, 'PILOT', 'e'.repeat(40), true));
    await f.db.exec(readFileSync(MIGRATION, 'utf8'));
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(
      await as(f.db, 'inv', () => readMu7Bundle(data, 'PILOT', 'e'.repeat(40), true)),
      bundle,
    );
    const profile = await as(f.db, 'pt1', () => readReviewerProfile(data));
    assert.equal(profile?.profileId, 'mu81-plain-language-r3');
    assert.equal(profile?.guideText, reviewerGuideText('mu81-plain-language-r3'));
    const p = {
      profile_id: MU81_REVIEWER_PROFILE_ID,
      rubric_sha256: MU81_REVIEWER_GUIDE_SHA256,
      attestation: ATT,
    };
    await assert.rejects(
      one(f.db, 'inv', `select public.rpc_mu81_bind_reviewer_profile('${JSON.stringify(p)}')`),
      /MU81-P02/,
    );
  } finally {
    await f.db.close();
  }
});

test('revision 4 still requires an investigator, exact paired checksum and an unused design', async () => {
  const f = await signedOffPilot({ designVersion: 'SYN-8-1-NEW-GUIDE', stopAfter: 'design' });
  const bind = (profileId: string, hash: string) =>
    `select public.rpc_mu81_bind_reviewer_profile('${JSON.stringify({ profile_id: profileId, rubric_sha256: hash, attestation: ATT })}')`;
  const valid = bind(MU81_REVIEWER_PROFILE_ID, MU81_REVIEWER_GUIDE_SHA256);
  try {
    for (const who of ['pt1', 'r1', 'adj', 'out', 'inv1'] as const)
      await assert.rejects(one(f.db, who, valid), /investigator role/);
    await assert.rejects(
      one(
        f.db,
        'inv',
        bind(MU81_REVIEWER_PROFILE_ID, MU81_REVIEWER_PROFILES['mu81-plain-language-r3'].sha256),
      ),
      /MU81-P03/,
    );
    await one(f.db, 'inv', valid);
    assert.equal(
      await one(f.db, 'owner', 'select count(*)::int from public.mu7_gate_approvals'),
      0,
    );
    const profile = await as(f.db, 'pt1', () =>
      readReviewerProfile(mu7SqlData({ query: (q, p) => f.db.query(q, p) })),
    );
    assert.match(profile!.guideText, /## 2\. Different things you are judging/);
    await assert.rejects(
      f.db.exec("update public.mu7_reviewer_profile_v81 set profile_id='mu81-plain-language-r3'"),
      /append-only|immutable|not permitted|forbidden/i,
    );
  } finally {
    await f.db.close();
  }
});
