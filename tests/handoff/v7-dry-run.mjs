// =============================================================================
// dry_run_private_v7.mjs : PRIVATE dry run of the real v7 import files against NNNN_v7_mapping_units.sql (PGlite, in
// memory, nothing persists). Runs on the investigator's or developer's machine only: it reads data_private files with
// real NCT IDs and registry text. It prints and writes COUNTS and guard tags only, never an NCT ID.
//
// What it shows:
//   1. every one of the 100 PROPOSED units and the 3 worked examples passes every import guard;
//   2. the freeze with the manifest hashes is refused by MU7-G29 only (the 4 Pain units wait for gate G-PAIN-01),
//      which proves that the database recomputes the same unit list, assignment set and design-row hashes as the design
//      scripts (MU7-G28 comes first);
//   3. after a DRY-RUN-ONLY approval of G-PAIN-01, the freeze succeeds, and the real queues (QUEUE_ORDER of the import
//      file, both reviewer slots) pass MU7-G60 to MU7-G63 (every unit, primary first, no adjacent units of one trial, the
//      frozen queue hash); the five frozen hashes verify.
// The sign-off and the two FORMAL reviewer rows needed for step 3 are inserted with triggers off: this is a dry run of
// the imports and hashes, not of the pilot.
// Usage: node dry_run_private_v7.mjs <auth_shim> <schema> <0002> <0003> <0004> <0005> <0006> <NNNN>
//          <MU7_IMPORT_UNITS_v7_PROPOSED_PRIVATE.json> <MU7_IMPORT_TRAINING_v7_PRIVATE.json> <out.json>
// =============================================================================
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import crypto from 'crypto';
import fs from 'fs';

const A = process.argv.slice(2);
if (A.length !== 11) { console.error('usage: see header'); process.exit(2); }
const outPath = A[10];
if (fs.existsSync(outPath)) { console.error(`refusing to overwrite ${outPath}`); process.exit(2); }
const units = JSON.parse(fs.readFileSync(A[8], 'utf8'));
const training = JSON.parse(fs.readFileSync(A[9], 'utf8'));
const db = await PGlite.create({ extensions: { pgcrypto } });
for (const f of A.slice(0, 8)) await db.exec(fs.readFileSync(f, 'utf8'));
const INV = { sub: '00000000-0000-4000-8000-0000000000a1', email: 'investigator@example.test', aal: 'aal2' };
const ATT = 'Private dry run only; nothing here is a study decision.';
await db.query('insert into auth.users (id, email) values ($1, $2)', [INV.sub, INV.email]);
await db.query("insert into public.users (email, display_name, role) values ($1, 'Dry-run investigator', 'INVESTIGATOR')", [INV.email]);
async function asInv() { await db.exec('reset role;'); await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(INV)]); await db.exec('set role authenticated;'); }
const tag = (m) => (String(m).match(/MU7-G\d{2}|mu7_[a-z0-9_]+_ck|[a-z_]+ violates[^"]*/) || ['OTHER'])[0];
async function call(sql, params = []) { try { await asInv(); const r = await db.query(sql, params); await db.exec('reset role;'); return { ok: true, rows: r.rows }; } catch (e) { await db.exec('reset role;'); return { ok: false, tag: tag(e.message) }; } }
const report = { status: 'PRIVATE DRY RUN: counts and guard tags only', migration_sha256: crypto.createHash('sha256').update(fs.readFileSync(A[7], 'utf8')).digest('hex'), steps: {} };
await call('select public.rpc_claim_account()');
const fm = units.units.filter((u) => u.mode === 'FORMAL');
const prim = fm.filter((u) => u.unit_role === 'PRIMARY').length, sub = fm.length - prim;
const overlap = [...new Set(fm.map((u) => u.design.overlap_setting))];
let r = await call(`select public.rpc_mu7_record_design($1::jsonb)`, [JSON.stringify({ design_version: units.design_version, assignment_set_id: units.assignment_set_id,
  overlap_setting: overlap[0], n_primary_planned: prim, n_subgroup_planned: sub, attestation: ATT })]);
report.steps.design = { ok: r.ok, tag: r.tag ?? null, overlap_setting: overlap, n_primary: prim, n_subgroup: sub };
const tr = { imported: 0, refused: {} };
for (const t of training.units) { const x = await call('select public.rpc_mu7_import_training_unit($1::jsonb)', [JSON.stringify(t)]); if (x.ok) tr.imported += 1; else tr.refused[x.tag] = (tr.refused[x.tag] || 0) + 1; }
report.steps.training_units = tr;
const im = { imported: 0, refused: {} };
for (const u of fm) { const x = await call('select public.rpc_mu7_import_unit($1::jsonb)', [JSON.stringify(u)]); if (x.ok) im.imported += 1; else im.refused[x.tag] = (im.refused[x.tag] || 0) + 1; }
report.steps.formal_units = im;
const counts = async (sql) => { await db.exec('reset role;'); return (await db.query(sql)).rows; };
report.steps.blocked_units = (await counts("select freeze_gate, count(*)::int as n from public.mu7_unit_design where freeze_status = 'BLOCKED_PENDING_GATE' group by freeze_gate"));
report.steps.mental_health_units_with_note = (await counts("select count(*)::int as n from public.mu7_units where category = 'MENTAL_HEALTH' and packet -> 'unit' ? 'display_note'"))[0].n;
report.steps.units_with_detailed_description = (await counts("select count(*)::int as n from public.mu7_units where mode = 'FORMAL' and packet -> 'trial' ? 'detailed_description'"))[0].n;
const H = units.manifest_hashes;
const fz = (att) => call('select public.rpc_mu7_freeze($1::jsonb)', [JSON.stringify({ unit_list_sha256: H.unit_list_sha256, assignment_set_sha256: H.assignment_set_sha256,
  design_rows_sha256: H.design_rows_sha256, queue_sha256: H.queue_sha256, attestation: att })]);
r = await fz(ATT);
report.steps.freeze_with_gate_open = { ok: r.ok, tag: r.tag ?? null, expected: 'refused by MU7-G29 (G-PAIN-01 open)' };
r = await call(`select public.rpc_mu7_approve_gate('G-PAIN-01', $1, 'DRY RUN ONLY, not an investigator decision')`, [ATT]);
r = await fz(ATT);
report.steps.freeze_after_dry_run_gate = { ok: r.ok, tag: r.tag ?? null };
// sign-off and two FORMAL reviewers with triggers off (dry run of the queue only)
await db.exec('reset role;');
const inv = (await db.query('select user_id from public.users where email = $1', [INV.email])).rows[0].user_id;
await db.exec(`do $$ begin perform set_config('session_replication_role', 'replica', true);
  insert into public.mu7_phase_events (event_type, checklist_version, checklist_sha256, app_git_sha, pilot_export_id, attestation, actor)
  values ('PILOT_SIGNED_OFF', 'DRY-RUN', repeat('1', 64), 'dry-run', gen_random_uuid(), '${ATT}', '${inv}');
  insert into public.users (email, display_name, role, is_pilot_test_account) values ('dry1@example.test', 'dry 1', 'REVIEWER', false), ('dry2@example.test', 'dry 2', 'REVIEWER', false);
  insert into public.reviewers (reviewer_pseudo_id, user_id, mode_scope, enrolled_by)
    select case email when 'dry1@example.test' then 'R-DRY1' else 'R-DRY2' end, user_id, 'FORMAL', '${inv}' from public.users where email like 'dry%@example.test';
  end $$;`);
const slots = [1, 2].map((s) => ({ reviewer_slot: s, reviewer_pseudo_id: `R-DRY${s}`, unit_ids: units.queue.filter((q) => Number(q.reviewer_slot) === s)
  .sort((a, b) => Number(a.queue_position) - Number(b.queue_position)).map((q) => q.unit_id) }));
r = await call(`select public.rpc_mu7_assign_queue('FORMAL', $1::jsonb) as n`, [JSON.stringify({ slots })]);
report.steps.queue = { ok: r.ok, tag: r.tag ?? null, rows: r.ok ? r.rows[0].n : null };
r = await call('select quantity, matches from public.rpc_mu7_verify_freeze()');
report.steps.verify_freeze = r.ok ? Object.fromEntries(r.rows.map((x) => [x.quantity, x.matches])) : { tag: r.tag };
report.pass = report.steps.design.ok && tr.imported === training.units.length && im.imported === fm.length
  && report.steps.freeze_with_gate_open.tag === 'MU7-G29' && report.steps.freeze_after_dry_run_gate.ok && report.steps.queue.ok
  && Object.values(report.steps.verify_freeze).every((v) => v === true);
fs.writeFileSync(outPath, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report));
await db.close();
