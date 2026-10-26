// Fictional, full-size candidate; never reads study material.
import { createHash } from 'node:crypto';
import {
  MU81_REVIEWER_PROFILE_ID,
  MU81_REVIEWER_GUIDE_SHA256,
  mu81ProfileDisplayText,
} from '../src/lib/mu81-reviewer-profile';
import {
  ATT,
  importObj,
  one,
  signedOffPilot,
  syntheticNct,
  type FixtureDb,
  type Unit,
} from './mu7-fixture';
import { formalIntakeSchema } from '../src/lib/formal-intake';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export async function syntheticIntake() {
  const f = await signedOffPilot({ stopAfter: 'accounts' });
  const db = f.db;
  try {
    const design = {
      design_version: 'review-design-v8.1.0' as const,
      assignment_set_id: 'SYN7-ASSIGN-INTAKE',
      overlap_setting: 'ONE_PER_TRIAL' as const,
      n_primary_planned: 96 as const,
      n_subgroup_planned: 4 as const,
    };
    const profile = {
      profile_id: MU81_REVIEWER_PROFILE_ID,
      rubric_sha256: MU81_REVIEWER_GUIDE_SHA256,
    };
    await one(db, 'inv', 'select public.rpc_mu7_record_design($1::jsonb)', [
      JSON.stringify({ ...design, attestation: ATT }),
    ]);
    await one(db, 'inv', 'select public.rpc_mu81_bind_reviewer_profile($1::jsonb)', [
      JSON.stringify({ ...profile, attestation: ATT }),
    ]);
    const areas = [
      'PATHOLOGICAL',
      'ONCOLOGY',
      'NEUROLOGICAL',
      'IMMUNE',
      'MENTAL_HEALTH',
      'RESPIRATORY',
      'INFECTIOUS',
      'METABOLIC',
      'UROGENITAL',
      'CARDIOVASCULAR',
    ];
    const conditions = [
      'CAN_ALL',
      'DIAB',
      'DEP',
      'OBE',
      'AST',
      'COPD',
      'COV',
      'SCZ',
      'HTN',
      'PAIN',
    ];
    const groups: Record<string, string> = {
      RULE_D_KEPT: 'D4B_KEEP_UNRESOLVED_COMPLICATION_ONLY',
      RULE_D_REMOVED: 'D2_REMOVE_OTHER_TYPE',
      RULE_K_KEPT: 'K_KEEP_MALIGNANT_COMPATIBLE',
      RULE_K_REMOVED: 'K_REMOVE_VERIFIED_NONMALIGNANT',
    };
    const units: ReturnType<typeof importObj>[] = [];
    for (const [fam, cats] of [
      ['AREA', areas],
      ['ROW', conditions],
      ['SG', Object.keys(groups)],
    ] as const) {
      for (const [rank, cat] of cats.entries()) {
        const n = fam === 'AREA' ? (rank < 6 ? 6 : 5) : fam === 'ROW' ? 4 : 1;
        for (let i = 0; i < n; i++) {
          const u: Unit = {
            uid: `MU7-${fam}-${cat}-${String(801 + i)}`,
            fam,
            cat,
            code: fam === 'AREA' ? 'IN_AREA' : fam === 'ROW' ? 'IN_ROW' : groups[cat],
            nct: syntheticNct(101 + units.length),
            N: 100,
            n,
            gate: cat === 'PAIN' ? 'G-PAIN-01' : undefined,
          };
          const p = importObj(u);
          p.packet.unit.mapping_label = await one(
            db,
            'owner',
            'select private.mu7_mapping_label($1,$2)',
            [fam, cat],
          );
          p.packet.unit.display_text =
            mu81ProfileDisplayText(u.code) ??
            (await one(db, 'owner', 'select private.mu7_display_text($1,$2)', [fam, u.code]));
          Object.assign(p.design, {
            design_version: design.design_version,
            overlap_setting: design.overlap_setting,
          });
          p.assignment.assignment_set_id = design.assignment_set_id;
          p.assignment.row_sha256 = sha(
            [
              p.assignment.assignment_set_id,
              p.unit_id,
              p.assignment.mapping_code,
              p.assignment.assignment_code,
              p.assignment.assignment_status,
            ].join('|'),
          );
          await one(db, 'inv', 'select public.rpc_mu7_import_unit($1::jsonb)', [JSON.stringify(p)]);
          units.push(p);
        }
      }
    }
    units.sort((a, b) => (a.unit_id < b.unit_id ? -1 : 1));
    const queue = ['1', '2'].flatMap((reviewer_slot) =>
      units.map((u, i) => ({
        reviewer_slot: reviewer_slot as '1' | '2',
        queue_position: String(i + 1),
        unit_id: u.unit_id,
      })),
    );
    const rows = units.map((u) => ({
      unit_id: u.unit_id,
      pi_i: '0.01',
      mc_standard_error: '0.001',
    }));
    const body = rows.map((r) => `${r.unit_id},${r.pi_i},${r.mc_standard_error}\n`).join('');
    const csv =
      'unit_id,stratum,N_h,n_h,nominal_probability_n_h_over_N_h,pi_mc_ONE_PER_TRIAL,mc_se,pattern_group_units,weight_ONE_PER_TRIAL,ratio_mc_to_nominal\n' +
      units
        .map(
          (u) =>
            [
              u.unit_id,
              u.design.stratum,
              u.design.frame_stratum_size,
              u.design.n_sampled_in_stratum,
              u.design.selection_probability,
              '0.01',
              '0.001',
              '1',
              '100',
              0.01 / u.design.selection_probability,
            ].join(',') + '\n',
        )
        .join('');
    const binding = {
      binding_version: 'mu81-probability-1',
      method: 'MONTE_CARLO_ONE_PER_TRIAL',
      replicates: 20000,
      seed: 1,
      source_csv: csv,
      file_sha256: sha(csv),
      rows_sha256: sha(body),
      rows,
    };
    const bindingSha = await one(
      db,
      'inv',
      'select public.rpc_mu81_bind_probabilities($1::jsonb)',
      [JSON.stringify(binding)],
    );
    const values: Record<string, string> = {};
    for (const [name, table, expression] of [
      ['unit_list_sha256', 'mu7_units', 'unit_id'],
      ['assignment_set_sha256', 'mu7_frozen_assignments', 'row_sha256'],
      ['design_rows_sha256', 'mu7_unit_design', 'design_row_sha256'],
      ['packet_inventory_sha256', 'mu7_units', "unit_id||'|'||packet_sha256"],
    ])
      values[name] = (await one(
        db,
        'owner',
        `select private.sha256_hex(string_agg(${expression},E'\\n' order by unit_id collate "C")) from public.${table}`,
      )) as string;
    return formalIntakeSchema.parse({
      format: 'civicsample-formal-intake-1.0',
      prepared_by_build: 'a'.repeat(40),
      source_import_sha256: sha(JSON.stringify(units)),
      design,
      reviewer_profile: profile,
      units,
      queue,
      expected: {
        ...values,
        queue_sha256: sha(
          queue.map((q) => `${q.reviewer_slot}|${q.queue_position}|${q.unit_id}`).join('\n'),
        ),
        probability_binding_sha256: bindingSha,
      },
      probability_binding: binding,
    });
  } finally {
    await db.close();
  }
}
export async function emptyIntakeDatabase(existing?: FixtureDb) {
  return (await signedOffPilot({ stopAfter: 'accounts', existing })).db;
}
