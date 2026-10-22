import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/** Private data stays in memory. Error codes never contain a cell, identifier or pathname. */
export class ImportValidationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'ImportValidationError';
  }
}
const refuse = (code: string): never => {
  throw new ImportValidationError(code);
};
export type CsvRow = Readonly<Record<string, string>>;
export interface VerifiedCsv {
  readonly sha256: string;
  readonly headers: readonly string[];
  readonly rows: readonly CsvRow[];
}
export interface PrivateFileInput {
  file: string;
  expectedSha256: string;
  repositoryRoot: string;
}

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

/** Hash the exact bytes before UTF-8 decoding or CSV parsing. Symlinks resolve before location checks. */
export async function readVerifiedPrivateCsv(input: PrivateFileInput): Promise<VerifiedCsv> {
  if (!/^[0-9a-f]{64}$/.test(input.expectedSha256)) refuse('EXPECTED_SHA256_REQUIRED');
  let file: string;
  let root: string;
  try {
    [file, root] = await Promise.all([realpath(input.file), realpath(input.repositoryRoot)]);
  } catch {
    return refuse('PRIVATE_FILE_UNAVAILABLE');
  }
  if (
    isWithin(root, file) ||
    isWithin(path.resolve(input.repositoryRoot), path.resolve(input.file))
  )
    refuse('PRIVATE_FILE_MUST_BE_OUTSIDE_REPOSITORY');
  let bytes: Buffer;
  try {
    const metadata = await stat(file);
    if (!metadata.isFile() || metadata.size > 32 * 1024 * 1024) refuse('PRIVATE_FILE_SIZE_OR_TYPE');
    bytes = await readFile(file);
  } catch (error) {
    if (error instanceof ImportValidationError) throw error;
    return refuse('PRIVATE_FILE_UNAVAILABLE');
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (!timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(input.expectedSha256, 'hex')))
    refuse('PRIVATE_FILE_HASH_MISMATCH');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return refuse('INVALID_UTF8');
  }
  return { sha256: digest, ...parseCsv(text) };
}

/** Strict RFC-style CSV: quoted newlines/commas/escaped quotes, LF or CRLF, unique headers. */
export function parseCsv(text: string): Omit<VerifiedCsv, 'sha256'> {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let state: 'START' | 'PLAIN' | 'QUOTED' | 'CLOSED' = 'START';
  let endedLine = false;
  const endCell = () => {
    record.push(cell);
    cell = '';
    state = 'START';
  };
  const endRecord = () => {
    endCell();
    records.push(record);
    record = [];
    endedLine = true;
    if (records.length > 100001) refuse('CSV_TOO_LARGE');
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    endedLine = false;
    if (state === 'QUOTED') {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else state = 'CLOSED';
      } else cell += c;
    } else if (c === ',') endCell();
    else if (c === '\n') endRecord();
    else if (c === '\r') {
      if (text[i + 1] !== '\n') refuse('CSV_MALFORMED');
      i++;
      endRecord();
    } else if (state === 'CLOSED') refuse('CSV_MALFORMED');
    else if (c === '"') {
      if (state !== 'START') refuse('CSV_MALFORMED');
      state = 'QUOTED';
    } else {
      cell += c;
      state = 'PLAIN';
    }
    if (cell.length > 100000 || record.length > 256) refuse('CSV_TOO_LARGE');
  }
  if (state === 'QUOTED') refuse('CSV_MALFORMED');
  if (!endedLine && (cell.length || record.length || state !== 'START')) endRecord();
  const headers = records.shift();
  if (!headers?.length) return refuse('CSV_HEADERS_INVALID');
  if (
    headers.some((h) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(h)) ||
    new Set(headers).size !== headers.length
  )
    refuse('CSV_HEADERS_INVALID');
  if (!records.length) refuse('CSV_EMPTY');
  const rows = records.map((values) => {
    if (values.length !== headers.length) refuse('CSV_COLUMN_COUNT');
    const row: Record<string, string> = Object.create(null);
    headers.forEach((header, i) => {
      row[header] = values[i];
    });
    return Object.freeze(row);
  });
  return { headers, rows };
}

function count(file: VerifiedCsv, expectedRows: number): void {
  if (!Number.isSafeInteger(expectedRows) || expectedRows < 1)
    refuse('EXPECTED_ROW_COUNT_REQUIRED');
  if (file.rows.length !== expectedRows) refuse('ROW_COUNT_MISMATCH');
}
function columns(file: VerifiedCsv, required: readonly string[]): void {
  if (required.some((field) => !file.headers.includes(field))) refuse('REQUIRED_COLUMN_MISSING');
}
function present(row: CsvRow, field: string): string {
  const value = row[field];
  if (typeof value !== 'string' || !value.trim()) refuse('REQUIRED_VALUE_MISSING');
  return value;
}
function unique(rows: readonly CsvRow[], field: string): void {
  const values = rows.map((row) => present(row, field));
  if (new Set(values).size !== values.length) refuse('DUPLICATE_IDENTIFIER');
}
function boolean(row: CsvRow, field: string): boolean {
  const value = present(row, field).toLowerCase();
  if (!['true', 'false'].includes(value)) refuse('INVALID_BOOLEAN');
  return value === 'true';
}
function integer(row: CsvRow, field: string, minimum = 1): void {
  const value = present(row, field);
  if (!/^\d+$/.test(value) || BigInt(value) < BigInt(minimum)) refuse('INVALID_INTEGER');
}
function oneOf(value: string, allowed: readonly string[], code: string): void {
  if (!allowed.includes(value)) refuse(code);
}
const unitTypes = ['DESCRIPTOR_AREA', 'TRIAL_AREA'];
const binary = ['INCLUDE', 'EXCLUDE'];
const rawStatuses = [
  ...binary,
  'CONTEXT_DEPENDENT',
  'INSUFFICIENT_EVIDENCE',
  'NOT_IN_DECISION_FILE',
];
const areas = [
  'oncology',
  'cardiovascular',
  'mental_health',
  'infectious',
  'metabolic',
  'neurological',
  'respiratory',
];

// Decimal rational arithmetic preserves input strings and avoids binary-float rounding in checks.
function decimal(value: string): [bigint, bigint] {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match || value.length > 100) return refuse('INVALID_DECIMAL');
  const scale = (match[2]?.length ?? 0) - Number(match[3] ?? 0);
  if (!Number.isSafeInteger(scale) || Math.abs(scale) > 100) refuse('INVALID_DECIMAL');
  const numerator = BigInt(match[1] + (match[2] ?? ''));
  return scale >= 0 ? [numerator, 10n ** BigInt(scale)] : [numerator * 10n ** BigInt(-scale), 1n];
}
function probabilityWeight(row: CsvRow, probabilityColumn: string, weightColumn: string): void {
  const [pn, pd] = decimal(present(row, probabilityColumn));
  const [wn, wd] = decimal(present(row, weightColumn));
  if (pn <= 0n || pn > pd || wn < wd) refuse('INVALID_PROBABILITY_OR_WEIGHT');
  const difference = pn * wn - pd * wd;
  // Match the existing database/analysis reciprocal tolerance; do not round or replace values.
  if ((difference < 0n ? -difference : difference) * 1_000_000_000n > pd * wd)
    refuse('WEIGHT_PROBABILITY_MISMATCH');
}
function requireWeightColumn(column: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(column ?? '')) refuse('WEIGHT_COLUMN_REQUIRED');
}

export interface DevelopmentUnit {
  dev_case_id: string;
  frame_unit_id: string;
  unit_type: string;
  primary_exclusion_reason: string;
  exclusion_reasons: string;
}
/** Ready for the existing investigator RPC once staging activation/prerequisites are authorized. No RPC is called here. */
export function validateDevelopment(file: VerifiedCsv, expectedRows: number): DevelopmentUnit[] {
  count(file, expectedRows);
  columns(file, [
    'dev_case_id_v4',
    'record_category',
    'frame_unit_id_v3',
    'unit_type',
    'primary_exclusion_reason',
    'exclusion_reasons',
  ]);
  unique(file.rows, 'dev_case_id_v4');
  unique(file.rows, 'frame_unit_id_v3');
  return file.rows.map((row) => {
    if (!/^DEV4-[A-Za-z0-9-]{1,40}$/.test(present(row, 'dev_case_id_v4')))
      refuse('DEVELOPMENT_ID_INVALID');
    if (row.record_category !== 'DEVELOPMENT') refuse('DEVELOPMENT_CATEGORY_INVALID');
    oneOf(present(row, 'unit_type'), unitTypes, 'UNIT_TYPE_INVALID');
    if (!/^E\d{2}_[A-Z0-9_]+$/.test(present(row, 'primary_exclusion_reason')))
      refuse('EXCLUSION_REASON_INVALID');
    const frame = present(row, 'frame_unit_id_v3');
    if (frame.length < 3 || frame.length > 200) refuse('FRAME_UNIT_INVALID');
    return {
      dev_case_id: row.dev_case_id_v4,
      frame_unit_id: frame,
      unit_type: row.unit_type,
      primary_exclusion_reason: row.primary_exclusion_reason,
      exclusion_reasons: present(row, 'exclusion_reasons'),
    };
  });
}

const sampleColumns = [
  'case_id_v4',
  'frame_unit_id_v3',
  'unit_type',
  'unit_id',
  'descriptor_ui',
  'descriptor_name',
  'area',
  'nct_id',
  'record_category',
  'provenance_audit_result',
  'tuning_use_allowed',
  'selection_stratum_v4',
  'variance_stratum_v4',
  'variance_stratum_N_v4',
  'N_h',
  'selection_probability_v4',
  'sampling_design_version',
  'seed_v4',
  'tier0_original_binary',
  'tier1_v11_status_raw',
  'tier1_v11_binary',
  'comparison_cell_v11',
  'two_step_descriptor_then_trial',
  'impact_tier_v4',
  'policy_governed_neoplasm_GEN06',
];
export function validateHeldout(
  file: VerifiedCsv,
  options: { expectedRows: number; weightColumn: string; development: readonly DevelopmentUnit[] },
): readonly CsvRow[] {
  count(file, options.expectedRows);
  requireWeightColumn(options.weightColumn);
  columns(file, [...sampleColumns, options.weightColumn]);
  if (!options.development.length) refuse('DEVELOPMENT_REGISTRY_REQUIRED');
  const excluded = new Set(options.development.map((row) => row.frame_unit_id));
  unique(file.rows, 'case_id_v4');
  unique(file.rows, 'frame_unit_id_v3');
  const versions = new Set<string>();
  const seeds = new Set<string>();
  for (const row of file.rows) {
    sampleColumns.filter((field) => field !== 'nct_id').forEach((field) => present(row, field));
    if (!/^HO4-[A-Za-z0-9-]{1,40}$/.test(row.case_id_v4)) refuse('HELDOUT_ID_INVALID');
    if (
      row.record_category !== 'HELDOUT_FORMAL' ||
      row.provenance_audit_result !== 'NO_DEVELOPMENT_FLAG' ||
      boolean(row, 'tuning_use_allowed')
    )
      refuse('HELDOUT_PROVENANCE_INVALID');
    if (excluded.has(row.frame_unit_id_v3)) refuse('DEVELOPMENT_OVERLAP');
    oneOf(row.unit_type, unitTypes, 'UNIT_TYPE_INVALID');
    oneOf(row.area, areas, 'AREA_INVALID');
    oneOf(row.tier0_original_binary, binary, 'BINARY_LABEL_INVALID');
    oneOf(row.tier1_v11_binary, binary, 'BINARY_LABEL_INVALID');
    oneOf(row.tier1_v11_status_raw, rawStatuses, 'RAW_STATUS_INVALID');
    const trial = row.unit_type === 'TRIAL_AREA';
    if (boolean(row, 'two_step_descriptor_then_trial') !== trial)
      refuse('TWO_STEP_DESIGN_MISMATCH');
    if (trial ? !/^(?:NCT\d{8}|SYN-NCT-[A-Za-z0-9-]+)$/.test(row.nct_id) : row.nct_id !== '')
      refuse('TRIAL_IDENTIFIER_MISMATCH');
    boolean(row, 'policy_governed_neoplasm_GEN06');
    integer(row, 'N_h');
    integer(row, 'variance_stratum_N_v4');
    integer(row, 'seed_v4', 0);
    probabilityWeight(row, 'selection_probability_v4', options.weightColumn);
    versions.add(row.sampling_design_version);
    seeds.add(row.seed_v4);
  }
  if (versions.size !== 1 || seeds.size !== 1) refuse('MIXED_SAMPLING_PROVENANCE');
  return file.rows;
}

export function validatePredictions(
  file: VerifiedCsv,
  options: {
    expectedRows: number;
    tier1Version: 'v1.1' | 'v1.2';
    sample: readonly CsvRow[];
    sampleWeightColumn: string;
  },
): readonly CsvRow[] {
  count(file, options.expectedRows);
  oneOf(options.tier1Version, ['v1.1', 'v1.2'], 'TIER_VERSION_REQUIRED');
  columns(file, [
    'prediction_set_id',
    'case_id',
    'determination_level',
    'tier0_binary',
    'tier1_version',
    'tier1_status_raw',
    'tier1_binary',
    'stage_c_trial_status',
    'prediction_frozen_at',
    'record_category',
    'frame_unit_id',
    'unit_type',
    'unit_id',
    'nct_id',
    'descriptor_ui',
    'area',
    'selection_stratum',
    'variance_stratum',
    'variance_stratum_size',
    'selection_probability',
    'sampling_weight',
    'comparison_cell',
    'impact_tier',
    'policy_governed_neoplasm_GEN06',
    'provenance_audit_result',
  ]);
  requireWeightColumn(options.sampleWeightColumn);
  if (!options.sample.length) refuse('VERIFIED_SAMPLE_REQUIRED');
  const required = new Set(
    options.sample.flatMap((row) =>
      (row.unit_type === 'TRIAL_AREA'
        ? ['DESCRIPTOR_LEVEL_IN_TRIAL_CASE', 'TRIAL_LEVEL']
        : ['DESCRIPTOR_LEVEL']
      ).map((level) => `${row.case_id_v4}\u0000${level}`),
    ),
  );
  const seen = new Set<string>();
  const sets = new Set<string>();
  const cases = new Map(options.sample.map((row) => [row.case_id_v4, row]));
  for (const row of file.rows) {
    const key = `${row.case_id}\u0000${row.determination_level}`;
    if (!required.has(key) || seen.has(key)) refuse('PREDICTION_CASE_LEVEL_MISMATCH');
    seen.add(key);
    sets.add(present(row, 'prediction_set_id'));
    const sample = cases.get(row.case_id)!;
    probabilityWeight(row, 'selection_probability', 'sampling_weight');
    const pairs = [
      ['record_category', 'record_category'],
      ['frame_unit_id', 'frame_unit_id_v3'],
      ['unit_type', 'unit_type'],
      ['unit_id', 'unit_id'],
      ['nct_id', 'nct_id'],
      ['descriptor_ui', 'descriptor_ui'],
      ['area', 'area'],
      ['selection_stratum', 'selection_stratum_v4'],
      ['variance_stratum', 'variance_stratum_v4'],
      ['impact_tier', 'impact_tier_v4'],
      ['provenance_audit_result', 'provenance_audit_result'],
      ['tier0_binary', 'tier0_original_binary'],
    ];
    if (pairs.some(([prediction, field]) => row[prediction] !== sample[field]))
      refuse('PREDICTION_SAMPLE_PROVENANCE_MISMATCH');
    for (const [prediction, field] of [
      ['variance_stratum_size', 'variance_stratum_N_v4'],
      ['selection_probability', 'selection_probability_v4'],
      ['sampling_weight', options.sampleWeightColumn],
    ]) {
      const [a, b] = decimal(present(row, prediction));
      const [c, d] = decimal(present(sample, field));
      if (a * d !== c * b) {
        // CSV serializers may emit neighboring decimal representations of one float.
        // Relative 1e-12 tolerance is restricted to probability, with no absolute floor.
        // This validates representation only; retain both original strings.
        const left = Number(row[prediction]);
        const right = Number(sample[field]);
        const equivalentProbability =
          prediction === 'selection_probability' &&
          Number.isFinite(left) &&
          Number.isFinite(right) &&
          left > 0 &&
          left <= 1 &&
          right > 0 &&
          right <= 1 &&
          Math.abs(left - right) <= 1e-12 * Math.max(Math.abs(left), Math.abs(right));
        if (!equivalentProbability) refuse('PREDICTION_SAMPLE_PROVENANCE_MISMATCH');
      }
    }
    if (
      boolean(row, 'policy_governed_neoplasm_GEN06') !==
      boolean(sample, 'policy_governed_neoplasm_GEN06')
    )
      refuse('PREDICTION_SAMPLE_PROVENANCE_MISMATCH');
    if (row.tier1_version !== options.tier1Version) refuse('TIER_VERSION_MISMATCH');
    if (row.prediction_frozen_at !== 'PENDING_FREEZE') refuse('PREDICTIONS_ALREADY_FROZEN');
    oneOf(row.tier0_binary, binary, 'BINARY_LABEL_INVALID');
    oneOf(row.tier1_binary, binary, 'BINARY_LABEL_INVALID');
    oneOf(row.tier1_status_raw, rawStatuses, 'RAW_STATUS_INVALID');
    oneOf(
      row.stage_c_trial_status,
      ['', 'INCLUDE', 'EXCLUDE', 'UNRESOLVED'],
      'STAGE_C_STATUS_INVALID',
    );
    const expected =
      row.determination_level === 'TRIAL_LEVEL'
        ? binary.includes(row.stage_c_trial_status)
          ? row.stage_c_trial_status
          : row.tier0_binary
        : row.tier1_status_raw === 'NOT_IN_DECISION_FILE'
          ? 'EXCLUDE'
          : binary.includes(row.tier1_status_raw)
            ? row.tier1_status_raw
            : row.tier0_binary;
    if (row.tier1_binary !== expected) refuse('PREDICTION_MAPPING_MISMATCH');
  }
  if (seen.size !== required.size || sets.size !== 1) refuse('PREDICTION_POPULATION_MISMATCH');
  return file.rows;
}

export function validateModuleB(
  file: VerifiedCsv,
  options: {
    expectedRows: number;
    expectedConditionRows: number;
    expectedTrialRows: number;
    weightColumn: string;
  },
): readonly CsvRow[] {
  count(file, options.expectedRows);
  requireWeightColumn(options.weightColumn);
  columns(file, [
    'module_b_unit_id',
    'record_category',
    'unit_type',
    'row_id',
    'stratum',
    'frame_N',
    'selection_probability',
    'pipeline_compatibility_status_PROVISIONAL_never_shown',
    'nct_id',
    'benchmark_id_shown',
    options.weightColumn,
  ]);
  unique(file.rows, 'module_b_unit_id');
  let conditions = 0;
  let trials = 0;
  for (const row of file.rows) {
    const condition = row.unit_type === 'CONDITION_ROW_BENCHMARK';
    if (row.record_category !== 'MODULE_B_FORMAL') refuse('MODULE_B_CATEGORY_INVALID');
    oneOf(
      row.unit_type,
      ['CONDITION_ROW_BENCHMARK', 'TRIAL_ELIGIBILITY'],
      'MODULE_B_UNIT_TYPE_INVALID',
    );
    if (
      !(condition ? /^MB4-ROW-[A-Za-z0-9_-]{2,60}$/ : /^MB4-T[A-Za-z0-9_-]{1,60}$/).test(
        present(row, 'module_b_unit_id'),
      )
    )
      refuse('MODULE_B_IDENTIFIER_MISMATCH');
    ['row_id', 'stratum'].forEach((field) => present(row, field));
    integer(row, 'frame_N');
    probabilityWeight(row, 'selection_probability', options.weightColumn);
    if (condition) {
      conditions++;
      if (row.nct_id !== '') refuse('MODULE_B_IDENTIFIER_MISMATCH');
    } else {
      trials++;
      if (!/^(?:NCT\d{8}|SYN-NCT-[A-Za-z0-9-]+)$/.test(present(row, 'nct_id')))
        refuse('MODULE_B_IDENTIFIER_MISMATCH');
    }
  }
  if (
    ![options.expectedConditionRows, options.expectedTrialRows].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    conditions !== options.expectedConditionRows ||
    trials !== options.expectedTrialRows
  )
    refuse('MODULE_B_COUNTS_MISMATCH');
  return file.rows;
}
