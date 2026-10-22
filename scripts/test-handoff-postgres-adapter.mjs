// Native driver adapter only. Preserved assertions and SQL remain unchanged.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { Client } from 'pg';

export const pgcrypto = {};
export const PGlite = {
  async create() {
    const connectionString = process.env.VERIFY_HANDOFF_DISPOSABLE_URL;
    assert.ok(connectionString, 'The parent harness must supply a disposable database');
    const expectedDatabase = new URL(connectionString).pathname.slice(1);
    assert.match(expectedDatabase, /^verify_handoff_[0-9]+_[0-9a-f]{16}$/);
    const client = new Client({ connectionString });
    await client.connect();
    try {
      const actual = (await client.query('select current_database() as name')).rows[0].name;
      assert.equal(
        actual,
        expectedDatabase,
        'Refusing to run outside the owned disposable database',
      );
    } catch (error) {
      await client.end();
      throw error;
    }
    return {
      async exec(sql) {
        await client.query(sql);
      },
      async query(sql, params = []) {
        const result = await client.query(sql, params);
        // These suites issue one statement per query. Do not silently select one
        // result and hide unexpected statements if the preserved runner changes.
        assert.ok(!Array.isArray(result), 'Unexpected multi-statement query result');
        return { rows: result.rows };
      },
      async close() {
        try {
          if (process.env.VERIFY_HANDOFF_AUDIT_OUTPUT) {
            await client.query('reset role');
            const row = (
              await client.query(
                "select count(*)::int as n, count(*) filter (where details ? 'step1_decision')::int as with_decision from public.audit_log where entity_table = 'trial_step1_records'",
              )
            ).rows[0];
            await writeFile(process.env.VERIFY_HANDOFF_AUDIT_OUTPUT, JSON.stringify(row), {
              mode: 0o600,
            });
          }
        } finally {
          await client.end();
        }
      },
    };
  },
};
