// Checks downloaded bundle 7.0, 8.1 or 8.2 files without a database or network connection:
//
//   node --import tsx scripts/verify-mu7-bundle.ts --bundle /abs/folder [--expect-manifest-sha256 <hash>]
//
// Every file's SHA-256 must equal the manifest, every CSV must carry exactly the contract's columns
// in order and the manifest's row count; forbidden metadata columns are rejected. With
// --expect-manifest-sha256 (the hash the database registered, from the investigator console or the
// read-only inspection) the manifest itself must match it. Prints one JSON line; exit 1 on failure.
import { createHash } from 'node:crypto';
import { HISTORY_COLUMNS, verifyJudgmentHistory } from '../src/lib/mu7-history';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MU7_EXPORT_COLUMNS,
  MU7_FORBIDDEN_COLUMNS,
  type Mu7ExportRole,
} from '../src/lib/mu7-export';
import { isMu81Design } from '../src/lib/mu7-types';

/** LF-delimited exporter CSV. A bare CR is field data in legacy exports, not a row separator. */
function csvRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = '',
    record: string[] = [];
  let state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (state === 'quoted') {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') state = 'closed';
      else field += c;
    } else if (c === ',' || c === '\n') {
      record.push(field);
      field = '';
      state = 'start';
      if (c === '\n') {
        records.push(record);
        record = [];
      }
    } else if (c === '"' && state === 'start') state = 'quoted';
    else {
      if (c === '"' || state === 'closed') throw new Error('invalid CSV');
      field += c;
      state = 'plain';
    }
  }
  if (state === 'quoted') throw new Error('unterminated CSV');
  if (field || record.length || state !== 'start') records.push([...record, field]);
  return records;
}
const SUBTYPE_COLUMNS = [
  'unit_id',
  'mode',
  'reviewer_slot',
  'revision_number',
  'answer',
  'diabetes_subtype',
  'content_sha256',
];
const PROBABILITY_COLUMNS = ['unit_id', 'pi_i', 'mc_standard_error'];
const SOURCE_COLUMNS = [
  'unit_id',
  'stratum',
  'N_h',
  'n_h',
  'nominal_probability_n_h_over_N_h',
  'pi_mc_ONE_PER_TRIAL',
  'mc_se',
  'pattern_group_units',
  'weight_ONE_PER_TRIAL',
  'ratio_mc_to_nominal',
];
const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const hashText = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const sameKeys = (obj: Record<string, unknown>, keys: string[]) =>
  sameList(Object.keys(obj).sort(), [...keys].sort());
// Exact decimal comparison, including scientific notation in the unchanged source CSV.
function decimal(v: string): string {
  const m = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(v);
  if (!m) throw new Error('invalid decimal');
  let exp = Number(m[3] ?? 0) - (m[2]?.length ?? 0);
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 1000)
    throw new Error('decimal exponent outside contract');
  let digits = (m[1] + (m[2] ?? '')).replace(/^0+/, '');
  if (!digits) return '0';
  while (digits.endsWith('0')) {
    digits = digits.slice(0, -1);
    exp++;
  }
  return `${digits}e${exp}`;
}

export function verifyMu7Bundle(dir: string, expectManifestSha?: string) {
  const problems: string[] = [];
  const rows: Record<string, number> = {};
  const texts: Record<string, string> = {};
  const tables: Record<string, string[][]> = {};
  const info: {
    manifestSha256?: string;
    mode?: 'PILOT' | 'FORMAL';
    format?: string;
    status?: string;
  } = {};
  const result = () => ({
    ok: problems.length === 0,
    ...info,
    registrationVerified: expectManifestSha !== undefined && problems.length === 0,
    rows,
    problems,
  });
  // Only fixed contract filenames are read; never follow a filename from the manifest.
  const read = (name: string): Buffer | null => {
    try {
      const path = join(dir, name);
      if (!lstatSync(path).isFile()) throw new Error('not a regular file');
      return readFileSync(path);
    } catch {
      problems.push(`${name}: missing or unreadable regular file`);
      return null;
    }
  };
  const bytes = read('manifest.json');
  if (!bytes) return result();
  info.manifestSha256 = hash(bytes);
  if (
    expectManifestSha !== undefined &&
    (!hashText(expectManifestSha) || info.manifestSha256 !== expectManifestSha)
  )
    problems.push('manifest.json differs from the registered manifest hash');
  let m: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!object(value)) throw new Error('invalid manifest');
    m = value;
  } catch {
    problems.push('manifest.json is not a valid UTF-8 JSON object');
    return result();
  }
  if (
    (m.bundle_format_version !== '7.0' &&
      m.bundle_format_version !== '8.1' &&
      m.bundle_format_version !== '8.2') ||
    (m.mode !== 'PILOT' && m.mode !== 'FORMAL') ||
    !object(m.files) ||
    !object(m.row_counts)
  ) {
    problems.push('unsupported bundle format, mode or file inventory');
    return result();
  }
  const mode = m.mode;
  const format = m.bundle_format_version;
  Object.assign(info, { mode, format });
  // Preserve standard exporter status text, never echo arbitrary manifest content.
  const statuses = [
    'SYNTHETIC PILOT: excluded from every statistic; the analysis reads FORMAL bundles only',
    'SYNTHETIC: written from a synthetic database (placeholder trials); never a study result',
    'FORMAL',
  ];
  if (typeof m.status === 'string' && statuses.includes(m.status)) info.status = m.status;
  if (typeof m.status !== 'string' || (mode === 'PILOT' && !m.status.startsWith('SYNTHETIC PILOT')))
    problems.push('a PILOT bundle must be marked SYNTHETIC PILOT');
  const columns: Record<string, readonly string[]> = Object.fromEntries(
    (Object.keys(MU7_EXPORT_COLUMNS) as Mu7ExportRole[]).map((r) => [
      `${r}.csv`,
      MU7_EXPORT_COLUMNS[r],
    ]),
  );
  if (format === '8.2') {
    columns['judgment_history.csv'] = HISTORY_COLUMNS;
    if (m.history_contract_version !== 'mu81-history-1')
      problems.push('unknown judgment history contract');
  }
  let needsProbabilities = false;
  if (format === '8.1' || format === '8.2') {
    if (
      !object(m.design) ||
      !isMu81Design(m.design.design_version) ||
      m.vocabulary_version !== 'mu81-subtype-1' ||
      (m.design.overlap_setting !== 'ALLOW' && m.design.overlap_setting !== 'ONE_PER_TRIAL')
    ) {
      problems.push('bundle 8.1 design or vocabulary is invalid');
      return result();
    }
    columns['subtype_observations.csv'] = SUBTYPE_COLUMNS;
    needsProbabilities = mode === 'FORMAL' && m.design.overlap_setting === 'ONE_PER_TRIAL';
    if (needsProbabilities) {
      columns['probabilities.csv'] = PROBABILITY_COLUMNS;
      columns['probability_source.csv'] = SOURCE_COLUMNS;
    } else if (
      m.probability_binding != null ||
      (object(m.freeze) && m.freeze.probability_binding_sha256 != null)
    )
      problems.push('this bundle must not carry a probability binding');
  } else if (object(m.design) && isMu81Design(m.design.design_version))
    problems.push('v8.1 design requires bundle format 8.1 or 8.2');
  if (!sameKeys(m.files, Object.keys(columns)) || !sameKeys(m.row_counts, Object.keys(columns)))
    problems.push('file inventory differs from the versioned bundle contract');
  for (const [name, header] of Object.entries(columns)) {
    const file = read(name);
    if (!file) continue;
    if (!hashText(m.files[name]) || hash(file) !== m.files[name])
      problems.push(`${name}: SHA-256 differs from the manifest`);
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(file);
      const records = csvRecords(text);
      texts[name] = text;
      tables[name] = records.slice(1);
      rows[name] = records.length - 1;
      if (!sameList(records[0] ?? [], header))
        problems.push(`${name}: columns differ from the bundle ${format} contract`);
      if ((records[0] ?? []).some((c) => MU7_FORBIDDEN_COLUMNS.test(c)))
        problems.push(`${name}: a forbidden column`);
      if (records.slice(1).some((r) => r.length !== header.length))
        problems.push(`${name}: row width differs from its header`);
      if (!Number.isSafeInteger(m.row_counts[name]) || rows[name] !== m.row_counts[name])
        problems.push(`${name}: row count differs from the manifest`);
    } catch {
      problems.push(`${name}: invalid UTF-8 or CSV serialization`);
    }
  }
  if (needsProbabilities && problems.length === 0) {
    try {
      const b = m.probability_binding;
      if (
        !object(b) ||
        !object(m.design) ||
        !object(m.freeze) ||
        b.binding_version !== 'mu81-probability-1' ||
        b.method !== 'MONTE_CARLO_ONE_PER_TRIAL' ||
        b.design_version !== m.design.design_version ||
        !Number.isSafeInteger(b.replicates) ||
        Number(b.replicates) <= 1 ||
        !Number.isSafeInteger(b.seed) ||
        Number(b.seed) < 0 ||
        Number(b.seed) >= 1e15
      )
        throw new Error('metadata');
      const p = tables['probabilities.csv'];
      const source = tables['probability_source.csv'];
      const ids = tables['units.csv'].map((r) => r[MU7_EXPORT_COLUMNS.units.indexOf('unit_id')]);
      const pids = p.map((r) => r[0]);
      const sourceById = new Map(source.map((r) => [r[0], r]));
      const canonical = /^(0|1|0\.[0-9]{0,29}[1-9])$/;
      if (
        new Set(ids).size !== ids.length ||
        new Set(pids).size !== pids.length ||
        sourceById.size !== source.length ||
        !sameList([...ids].sort(), pids) ||
        source.length !== ids.length ||
        p.some((r) => !canonical.test(r[1]) || r[1] === '0' || !canonical.test(r[2]))
      )
        throw new Error('coverage or decimal');
      const body = p.map((r) => r.join(',') + '\n').join('');
      if (
        texts['probabilities.csv'] !== PROBABILITY_COLUMNS.join(',') + '\n' + body ||
        hash(body) !== b.rows_sha256 ||
        hash(texts['probability_source.csv']) !== b.file_sha256
      )
        throw new Error('digest');
      for (const r of p) {
        const src = sourceById.get(r[0]);
        if (!src || decimal(src[5]) !== decimal(r[1]) || decimal(src[6]) !== decimal(r[2]))
          throw new Error('source');
      }
      const digest = hash(
        [
          'binding_version',
          'design_version',
          'method',
          'replicates',
          'seed',
          'file_sha256',
          'rows_sha256',
        ]
          .map((k) => String(b[k]))
          .join('|'),
      );
      if (digest !== b.binding_sha256 || digest !== m.freeze.probability_binding_sha256)
        throw new Error('freeze');
    } catch {
      problems.push('probability files or binding differ from the frozen contract');
    }
  }
  if (format === '8.2' && problems.length === 0) {
    try {
      const records = (name: string) =>
        tables[name].map((row) => Object.fromEntries(columns[name].map((k, i) => [k, row[i]])));
      verifyJudgmentHistory(
        records('judgment_history.csv'),
        records('independent_judgments.csv'),
        records('subtype_observations.csv'),
        mode,
        m.snapshot,
      );
    } catch {
      problems.push('judgment history differs from its locked snapshot or export contract');
    }
  }
  return result();
}

if (process.argv[1]?.endsWith('verify-mu7-bundle.ts')) {
  const options = new Map<string, string>();
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (
      !['--bundle', '--expect-manifest-sha256'].includes(args[i]) ||
      options.has(args[i]) ||
      !args[i + 1] ||
      args[i + 1].startsWith('--')
    ) {
      console.log(
        JSON.stringify({
          ok: false,
          problems: [
            'pass --bundle /abs/folder and optionally --expect-manifest-sha256 <registered hash>',
          ],
        }),
      );
      process.exit(2);
    }
    options.set(args[i], args[i + 1]);
  }
  const dir = options.get('--bundle');
  if (!dir) {
    console.log(JSON.stringify({ ok: false, problems: ['pass --bundle /abs/folder'] }));
    process.exit(2);
  }
  const result = verifyMu7Bundle(dir, options.get('--expect-manifest-sha256'));
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
