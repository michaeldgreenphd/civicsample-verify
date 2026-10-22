// SYNTHETIC ENGINEERING ONLY. Regenerates src/lib/tlv5-pilot-cases.ts from the committed
// synthetic pilot CSV (docs/design_v5/SYNTHETIC_PILOT_CASES_v5.csv). The CSV holds ten fictional
// trials; the module embeds them so the server never reads a data file at runtime.
import { readFileSync, writeFileSync } from 'node:fs';

const source = 'docs/design_v5/SYNTHETIC_PILOT_CASES_v5.csv';
const target = 'src/lib/tlv5-pilot-cases.ts';

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function render(csvText) {
  const [header, ...rows] = parseCsv(csvText).filter((r) => r.length > 1);
  const records = rows.map((r) => Object.fromEntries(header.map((k, i) => [k, r[i] ?? ''])));
  const split = (s) =>
    s
      ? s
          .split('|')
          .map((x) => x.trim())
          .filter(Boolean)
      : [];
  const cases = records.map((r) => {
    const [kind, ...rest] = r.interventions.split(':');
    return {
      caseId: r.case_id,
      nctId: r.nct_id,
      briefTitle: r.brief_title,
      officialTitle: r.official_title,
      conditionsRegistered: split(r.conditions_registered),
      conditionMeshHeadings: split(r.condition_mesh_headings),
      briefSummary: r.brief_summary,
      interventions: [
        { interventionType: kind.trim(), name: rest.join(':').trim(), description: 'fictional' },
      ],
      minimumAge: r.minimum_age,
      maximumAge: r.maximum_age,
      tier0Areas: split(r.pilot_label_tier0_areas),
      curatedV12Areas: split(r.pilot_label_curated_v12_areas),
      figure2Rows: split(r.pilot_label_figure2_rows),
      ruleD: r.pilot_label_rule_d || null,
      ruleK: r.pilot_label_rule_k || null,
      scriptAccount1: r.pilot_script_account_1,
      scriptAccount2: r.pilot_script_account_2,
      plantedDisagreement: r.planted_disagreement,
      notes: r.notes,
    };
  });
  return (
    '// SYNTHETIC ENGINEERING ONLY. Generated from docs/design_v5/SYNTHETIC_PILOT_CASES_v5.csv by scripts/generate-tlv5-pilot-cases.mjs; do not edit by hand.\n' +
    '// Ten fictional trials of the design v5 pilot (SYN-TLV5-001 to SYN-TLV5-010). Nothing here is a real trial or a study result.\n' +
    "import type { Tlv5PilotCase } from './tlv5-types';\n\n" +
    'export const TLV5_PILOT_CASES: readonly Tlv5PilotCase[] = ' +
    JSON.stringify(cases, null, 2) +
    ';\n'
  );
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  writeFileSync(target, render(readFileSync(source, 'utf8')));
  console.log(`wrote ${target}`);
}
