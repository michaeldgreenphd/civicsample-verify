import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Actor } from '../lib/types';

export const DEMO_ACTORS: Actor[] = [
  { id: '00000000-0000-4000-8000-000000000001', role: 'INVESTIGATOR', displayName: 'Pilot investigator' },
  { id: '00000000-0000-4000-8000-000000000002', role: 'REVIEWER', displayName: 'Pilot reviewer A' },
  { id: '00000000-0000-4000-8000-000000000003', role: 'REVIEWER', displayName: 'Pilot reviewer B' },
  { id: '00000000-0000-4000-8000-000000000004', role: 'ADJUDICATOR', displayName: 'Pilot adjudicator' },
];

// Share one initialization across Next development-module reloads. Never expose
// this owner connection outside server code. Requests use withActor below.
const globals = globalThis as typeof globalThis & { verifyDatabase?: Promise<PGlite> };
export async function getDb(): Promise<PGlite> {
  globals.verifyDatabase ??= initialize();
  return globals.verifyDatabase;
}

async function initialize(): Promise<PGlite> {
  const configured = process.env.VERIFY_DB_DIR;
  const directory = configured === 'memory' ? undefined : configured || path.join(process.cwd(), '.local', 'pglite');
  if (directory) await mkdir(directory, { recursive: true, mode: 0o700 });
  const db = new PGlite({ dataDir: directory, extensions: { pgcrypto } });
  await db.waitReady;
  const existing = await db.query<{ present: string | null }>("select to_regclass('public.verify_state')::text as present");
  if (!existing.rows[0].present) {
    // Keep each path literal: a variable path makes Next's server-file tracer
    // include the project directory, which can contain ignored local state.
    const migrations = await Promise.all([
      readFile(path.join(process.cwd(), 'supabase_test_shim/auth_shim.sql'), 'utf8'),
      readFile(path.join(process.cwd(), 'schema.sql'), 'utf8'),
      readFile(path.join(process.cwd(), 'migrations/0002_v3_review_design.sql'), 'utf8'),
      readFile(path.join(process.cwd(), 'migrations/0003_v4_record_categories_module_b.sql'), 'utf8'),
      readFile(path.join(process.cwd(), 'migrations/0004_synthetic_verify_workflow.sql'), 'utf8'),
    ]);
    for (const migration of migrations) await db.exec(migration);
  }
  if (!(await db.query<{ n: number }>('select count(*)::integer as n from public.verify_cases')).rows[0].n) await seedSynthetic(db);
  return db;
}

export async function withActor<T>(actor: Actor, operation: (tx: Parameters<Parameters<PGlite['transaction']>[0]>[0]) => Promise<T>): Promise<T> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    // PostgreSQL role and claims are transaction-local; PGlite serializes the
    // transaction, preventing one request's identity from bleeding into another.
    await tx.exec('set local role authenticated');
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: actor.id, aal: 'aal2' })]);
    const identity = await tx.query<{ role: string }>('select private.app_role() as role');
    if (identity.rows[0]?.role !== actor.role) throw new Error('Authenticated role mismatch');
    return operation(tx);
  });
}

async function seedSynthetic(db: PGlite): Promise<void> {
  await db.transaction(async (tx) => {
    for (const actor of DEMO_ACTORS) {
      const email = `pilot-${actor.id.slice(-1)}@example.invalid`;
      await tx.query('insert into auth.users(id,email) values($1,$2)', [actor.id, email]);
      await tx.query('insert into public.users(user_id,auth_uid,email,display_name,role,is_pilot_test_account) values($1,$1,$2,$3,$4,$5)', [actor.id, email, actor.displayName, actor.role, actor.role === 'REVIEWER']);
    }
    const areas = ['Cardiovascular', 'Respiratory', 'Neurological', 'Metabolic', 'Oncology', 'Infectious', 'Mental health', 'Cardiovascular', 'Respiratory', 'Neurological'];
    for (let i = 1; i <= 10; i++) {
      const id = `SYN-${String(i).padStart(3, '0')}`;
      const twoStep = i >= 9;
      const packet = {
        title: `Fictional condition ${String.fromCharCode(64 + i)}`,
        area: areas[i - 1],
        descriptorName: `Fictional condition ${String.fromCharCode(64 + i)}`,
        descriptorId: `TESTFX-D${String(i).padStart(4, '0')}`,
        scopeNote: `Synthetic training vignette ${i}. This invented descriptor describes a fictional condition used only to exercise the review workflow. ${twoStep ? 'Its role may depend on the fictional trial context.' : 'Judge its relationship to the displayed construct using the synthetic rubric.'}`,
        entryTerms: [`Fictional synonym ${i}`],
        treeNumbers: [{ number: `TESTFX.${String(i).padStart(3, '0')}`, label: 'Synthetic branch — no real MeSH classification' }],
        areaDefinition: `For this pilot only, consider whether the fictional condition belongs in the ${areas[i - 1].toLowerCase()} construct. This text is not a scientific rubric.`,
        source: 'Hand-authored fictional engineering fixture',
        sourceVersion: 'synthetic-v1',
      };
      const trial = twoStep ? {
        registryId: `SYN-NCT-${String(i).padStart(4, '0')}`,
        title: `Fictional trial ${i}`,
        summary: `An invented trial examines fictional condition ${String.fromCharCode(64 + i)} as ${i === 9 ? 'its primary condition' : 'a secondary complication of another fictional condition'}. No real trial is represented.`,
        conditions: [`Fictional condition ${String.fromCharCode(64 + i)}`],
        interventions: ['Fictional intervention'], primaryOutcomes: ['Fictional symptom change'],
        studyType: 'Synthetic interventional example', primaryPurpose: 'Synthetic treatment example', phase: 'Not applicable to fictional study', ageRange: 'Fictional adult population',
        source: 'Hand-authored fictional engineering fixture', sourceVersion: 'synthetic-v1',
      } : null;
      await tx.query('insert into public.verify_cases(id,kind,packet,trial_packet) values($1,$2,$3,$4)', [id, twoStep ? 'TWO_STEP' : 'DESCRIPTOR', JSON.stringify(packet), trial ? JSON.stringify(trial) : null]);
      // Fixed independent synthetic order, never a claim about a formal design.
      await tx.query('insert into public.verify_assignments(case_id,reviewer_id,position) values($1,$2,$3),($1,$4,$5)', [id, DEMO_ACTORS[1].id, i, DEMO_ACTORS[2].id, ((i * 3) % 10) + 1]);
    }
    await tx.query("insert into public.verify_audit(actor_id,action,details) values($1,'SYNTHETIC_INITIALIZED',$2)", [DEMO_ACTORS[0].id, JSON.stringify({ synthetic: true, rubric: 'synthetic-v1', formalEnabled: false })]);
  });
}
