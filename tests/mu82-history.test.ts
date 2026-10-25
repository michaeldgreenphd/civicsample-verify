// Migration safety uses only disposable, fictional databases.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { signedOffPilot, rows, one } from './mu7-fixture';

for (const designVersion of [undefined, 'SYN-8-1-HISTORY-UPGRADE'])
  test(`0036 preserves locked ${designVersion ?? 'v7'} data and export history`, async () => {
    const file = 'migrations/0036_v81_judgment_history.sql';
    const f = await signedOffPilot({ without: [file], designVersion });
    try {
      const tables = [
        'mu7_judgments',
        'mu7_snapshot',
        'mu7_reference_locks',
        'mu7_exports',
        'mu7_design',
        'mu7_freeze',
      ];
      const read = async () =>
        Promise.all(
          tables.map((t) =>
            rows(
              f.db,
              'owner',
              `select to_jsonb(x) as row from public.${t} x order by to_jsonb(x)::text`,
            ),
          ),
        );
      const before = await read();
      await f.db.exec(readFileSync(file, 'utf8'));
      assert.deepEqual(await read(), before);
      assert.equal(
        await one(
          f.db,
          'inv',
          "select count(*)::int from public.v_mu81_judgment_history where mode='PILOT'",
        ),
        24,
      );
      for (const role of ['pt1', 'pt2', 'r1', 'r2', 'adj', 'out', 'inv1'] as const)
        assert.equal(
          await one(f.db, role, 'select count(*)::int from public.v_mu81_judgment_history'),
          0,
        );
    } finally {
      await f.db.close();
    }
  });
