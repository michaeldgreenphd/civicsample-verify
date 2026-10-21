// SYNTHETIC ENGINEERING ONLY. Preserved supplied regression logic; see docs/HANDOFF_TESTS.md.
import { execFileSync } from 'child_process';
import fs from 'fs';

const ROOT = '../..';
const src = fs.readFileSync('../pglite_rls_v3/rls_tests_v3.mjs', 'utf8');
const marker = 'await db.close();\n';
if (src.split(marker).length !== 2) throw new Error('unexpected v3 harness layout');
const probe = "await db.exec('reset role;');\n" +
  "const leak = (await db.query(\"select count(*)::int as n, count(*) filter (where details ? 'step1_decision')::int as with_decision " +
  "from public.audit_log where entity_table = 'trial_step1_records'\")).rows[0];\n" +
  "console.log('AUDIT_PROBE ' + JSON.stringify(leak));\n";
fs.writeFileSync('_v3_audit_probe.tmp.mjs', src.replace(marker, probe + marker));
fs.writeFileSync('_combined_0002_0003.tmp.sql',
  fs.readFileSync(`${ROOT}/migrations/0002_v3_review_design.sql`, 'utf8') + fs.readFileSync(`${ROOT}/migrations/0003_v4_record_categories_module_b.sql`, 'utf8'));
const run = (migration) => {
  const out = execFileSync(process.execPath, ['_v3_audit_probe.tmp.mjs', `${ROOT}/supabase_test_shim/auth_shim.sql`, `${ROOT}/schema.sql`,
    migration, '_probe_results.tmp.json', '_probe_steps.tmp.sql'], { encoding: 'utf8' });
  const line = out.split('\n').find((l) => l.startsWith('AUDIT_PROBE '));
  return JSON.parse(line.slice('AUDIT_PROBE '.length));
};
const result = { v3_schema_0002: run(`${ROOT}/migrations/0002_v3_review_design.sql`), v4_schema_0002_0003: run('_combined_0002_0003.tmp.sql') };
for (const f of ['_v3_audit_probe.tmp.mjs', '_combined_0002_0003.tmp.sql', '_probe_results.tmp.json', '_probe_steps.tmp.sql']) fs.rmSync(f, { force: true });
fs.writeFileSync('audit-probe.json', JSON.stringify(result, null, 1) + '\n');
console.log(JSON.stringify(result));
