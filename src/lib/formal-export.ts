import { ENGINEERING_NOTICE, canonicalJson, sha256 } from './export';

/** Numeric database values must arrive as text, so CSV serialization cannot round them. */
export type V4Cell = string | boolean | null;
export type V4Row = Record<string, V4Cell>;
export interface V4SyntheticExportInput {
  manifest: Record<string, unknown>;
  independentJudgments: V4Row[];
  adjudicatedReference: V4Row[];
  frozenPredictions: V4Row[];
  integrity: { frozenPredictionsMatch: boolean; judgmentSnapshotMatch: boolean };
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const booleanManifestKeys = new Set([
  'is_synthetic_fixture',
  'reference_locked',
  'extension_approved_by_amendment',
]);
const permittedLevels = new Set([
  'DESCRIPTOR_LEVEL',
  'DESCRIPTOR_LEVEL_IN_TRIAL_CASE',
  'TRIAL_LEVEL',
]);

function cell(value: V4Cell): string {
  if (value === null) return '';
  if (typeof value !== 'string' && typeof value !== 'boolean')
    throw new Error('CSV cells must be explicit null, boolean, or database text');
  const text = String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

function render(
  rows: V4Row[],
  columns: readonly string[],
  exportId?: string,
  allowExtension = false,
): string {
  if (!rows.length) throw new Error('Synthetic v4 tables cannot be empty');
  const normalized = rows.map((row) => {
    const result = { ...row };
    if (exportId !== undefined) {
      if (row.export_id !== undefined && row.export_id !== exportId)
        throw new Error('Row export ID differs from manifest');
      result.export_id = exportId;
    }
    if (
      columns.some((column) => !(column in result)) ||
      Object.keys(result).some((column) => !columns.includes(column))
    ) {
      throw new Error('Row columns differ from the v4 contract');
    }
    const isHeldoutFormal =
      result.record_category === 'HELDOUT_FORMAL' &&
      typeof result.case_id === 'string' &&
      /^HO4-TESTFX-\d+$/.test(result.case_id);
    const isExtensionApproved =
      allowExtension &&
      result.record_category === 'HELDOUT_EXTENSION_APPROVED' &&
      typeof result.case_id === 'string' &&
      /^HO4R-TESTFX-\d+$/.test(result.case_id);
    if (!isHeldoutFormal && !isExtensionApproved) {
      throw new Error(
        'Only synthetic HO4-TESTFX held-out records may enter this engineering writer; pilot records are forbidden',
      );
    }
    if (
      typeof result.determination_level !== 'string' ||
      !permittedLevels.has(result.determination_level)
    )
      throw new Error('Invalid determination level');
    for (const [key, value] of Object.entries(result)) {
      cell(value);
      if (typeof value === 'string' && /\bNCT\d{8}\b/i.test(value))
        throw new Error('Real registry identifiers are forbidden');
      if (
        key === 'nct_id' &&
        value !== null &&
        value !== '' &&
        (typeof value !== 'string' || !/^SYN-NCT-\d+$/.test(value))
      )
        throw new Error('Trial identifiers must be fictional');
      if (
        key.endsWith('_at') &&
        (typeof value !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ||
          !Number.isFinite(Date.parse(value)))
      ) {
        throw new Error('Timestamps must already be valid ISO UTC text ending in Z');
      }
    }
    if ('unit_type' in result) {
      if (result.unit_type !== 'DESCRIPTOR_AREA' && result.unit_type !== 'TRIAL_AREA') {
        throw new Error('Row unit_type must be DESCRIPTOR_AREA or TRIAL_AREA');
      }
      const hasNct = result.nct_id !== null && result.nct_id !== '';
      if (result.unit_type === 'TRIAL_AREA' && !hasNct) {
        throw new Error('TRIAL_AREA rows must carry a fictional SYN-NCT identifier');
      }
      if (result.unit_type === 'DESCRIPTOR_AREA' && hasNct) {
        throw new Error('DESCRIPTOR_AREA rows must not carry a trial nct_id');
      }
      if (
        result.unit_type === 'DESCRIPTOR_AREA' &&
        result.determination_level !== 'DESCRIPTOR_LEVEL'
      ) {
        throw new Error('DESCRIPTOR_AREA rows must use DESCRIPTOR_LEVEL');
      }
      if (
        result.unit_type === 'TRIAL_AREA' &&
        result.determination_level !== 'DESCRIPTOR_LEVEL_IN_TRIAL_CASE' &&
        result.determination_level !== 'TRIAL_LEVEL'
      ) {
        throw new Error('TRIAL_AREA rows must use DESCRIPTOR_LEVEL_IN_TRIAL_CASE or TRIAL_LEVEL');
      }
    }
    return result;
  });
  const key = (row: V4Row) =>
    canonicalJson([row.case_id, row.determination_level, row.reviewer_slot ?? '']);
  if (new Set(normalized.map(key)).size !== normalized.length)
    throw new Error('Duplicate case-level record');
  if (columns.includes('unit_type')) {
    const levelsByCase = new Map<string, { unitType: string; levels: Set<string> }>();
    for (const row of normalized) {
      const cid = String(row.case_id);
      const ut = String(row.unit_type);
      const lvl = String(row.determination_level);
      const entry = levelsByCase.get(cid);
      if (!entry) {
        levelsByCase.set(cid, { unitType: ut, levels: new Set([lvl]) });
      } else {
        if (entry.unitType !== ut) {
          throw new Error('unit_type must stay consistent across each case');
        }
        entry.levels.add(lvl);
      }
    }
    for (const [, entry] of levelsByCase) {
      if (
        entry.unitType === 'TRIAL_AREA' &&
        (!entry.levels.has('DESCRIPTOR_LEVEL_IN_TRIAL_CASE') || !entry.levels.has('TRIAL_LEVEL'))
      ) {
        throw new Error(
          'Every TRIAL_AREA case must include both DESCRIPTOR_LEVEL_IN_TRIAL_CASE and TRIAL_LEVEL',
        );
      }
    }
  }
  normalized.sort(
    (a, b) =>
      compare(String(a.case_id), String(b.case_id)) ||
      compare(String(a.determination_level), String(b.determination_level)) ||
      compare(String(a.reviewer_slot ?? ''), String(b.reviewer_slot ?? '')),
  );
  return (
    columns.join(',') +
    '\n' +
    normalized.map((row) => columns.map((column) => cell(row[column])).join(',')).join('\n') +
    '\n'
  );
}

/** Use this exact renderer to hash the synthetic prediction file at its engineering freeze. */
export function renderV4SyntheticPredictions(
  rows: V4Row[],
  options?: { allowExtension?: boolean },
): string {
  const allowExtension =
    options?.allowExtension ??
    rows.some((row) => row.record_category === 'HELDOUT_EXTENSION_APPROVED');
  return render(rows, PREDICTION_COLUMNS, undefined, allowExtension);
}

/** Pure exporter: callers supply reference values, predictions, design metadata and integrity outcomes. */
export function buildV4SyntheticBundle(input: V4SyntheticExportInput) {
  const m = input.manifest;
  if (
    m.is_synthetic_fixture !== true ||
    m.reference_locked !== true ||
    m.mode !== 'FORMAL' ||
    m.review_module !== 'ONTOLOGY_AREA' ||
    m.export_format_version !== '4.0'
  ) {
    throw new Error(
      'A locked synthetic Module A v4 bundle is required; no clinical or pilot export is supported',
    );
  }
  if (
    input.integrity.frozenPredictionsMatch !== true ||
    input.integrity.judgmentSnapshotMatch !== true
  )
    throw new Error('Both database integrity verifications must match before export');
  for (const key of MANIFEST_KEYS_V4) {
    if (key === 'files') continue;
    const value = m[key];
    if (
      booleanManifestKeys.has(key)
        ? typeof value !== 'boolean'
        : typeof value !== 'string' || (key !== 'amendment_id' && !value)
    )
      throw new Error('Required manifest metadata is absent or has the wrong type');
    if (
      key.endsWith('_sha256') &&
      (typeof value !== 'string' || value.length !== 64 || !/^[0-9a-f]{64}$/.test(value))
    )
      throw new Error('Manifest provenance hashes must be 64-character lowercase SHA-256 values');
  }
  const allowExtension = m.extension_approved_by_amendment === true;
  if (!allowExtension) {
    if (String(m.amendment_id ?? '').trim() !== '') {
      throw new Error('amendment_id must be empty when extension_approved_by_amendment is false');
    }
  } else {
    if (
      typeof m.amendment_id !== 'string' ||
      !/^(AMD4|SYN|HO4|HO4R)-[A-Z0-9-]{1,40}$/.test(m.amendment_id.trim())
    ) {
      throw new Error('extension_approved_by_amendment requires a synthetic protocol amendment_id');
    }
    if (
      !input.frozenPredictions.some((row) => row.record_category === 'HELDOUT_EXTENSION_APPROVED')
    ) {
      throw new Error(
        'extension_approved_by_amendment is true, but no HELDOUT_EXTENSION_APPROVED records are present',
      );
    }
  }
  if (!['v1.1', 'v1.2'].includes(String(m.tier1_version_frozen)))
    throw new Error('The frozen Tier 1 version must be supplied');
  if (!['ALL_CASE_LEVELS', 'DISAGREEMENTS_ONLY'].includes(String(m.adjudication_scope)))
    throw new Error('The adjudication scope must be supplied');
  const caseKeys = (rows: V4Row[]) =>
    [...new Set(rows.map((row) => canonicalJson([row.case_id, row.determination_level])))].sort(
      compare,
    );
  const expected = canonicalJson(caseKeys(input.frozenPredictions));
  if (
    canonicalJson(caseKeys(input.independentJudgments)) !== expected ||
    canonicalJson(caseKeys(input.adjudicatedReference)) !== expected
  )
    throw new Error('Case-level populations must match across all three tables');
  const cases = [...new Set(input.frozenPredictions.map((row) => String(row.case_id)))].sort(
    compare,
  );
  if (sha256(cases.join('\n')) !== m.frozen_sample_case_list_sha256)
    throw new Error('Case list differs from the frozen sample');
  const files = [
    {
      name: 'synthetic_v4_independent_judgments.csv',
      role: 'independent_judgments',
      rows: input.independentJudgments.length,
      content: render(
        input.independentJudgments,
        JUDGMENT_COLUMNS,
        String(m.export_id),
        allowExtension,
      ),
    },
    {
      name: 'synthetic_v4_adjudicated_reference.csv',
      role: 'adjudicated_reference',
      rows: input.adjudicatedReference.length,
      content: render(
        input.adjudicatedReference,
        ADJUDICATION_COLUMNS,
        String(m.export_id),
        allowExtension,
      ),
    },
    {
      name: 'synthetic_v4_frozen_predictions.csv',
      role: 'frozen_predictions',
      rows: input.frozenPredictions.length,
      content: render(input.frozenPredictions, PREDICTION_COLUMNS, undefined, allowExtension),
    },
  ].map((file) => ({ ...file, sha256: sha256(file.content) }));
  if (files[2].sha256 !== m.frozen_prediction_set_sha256)
    throw new Error('Prediction file differs from the hash recorded at freeze');
  const manifest = Object.fromEntries(
    MANIFEST_KEYS_V4.filter((key) => key !== 'files').map((key) => [key, m[key]]),
  );
  manifest.notice = ENGINEERING_NOTICE;
  manifest.files = files.map((file) => ({
    name: file.name,
    role: file.role,
    sha256: file.sha256,
    rows: file.rows,
  }));
  return {
    notice: ENGINEERING_NOTICE,
    manifest,
    manifestContent: canonicalJson(manifest),
    manifest_sha256: sha256(canonicalJson(manifest)),
    files,
  };
}

export const JUDGMENT_COLUMNS = [
  'export_id',
  'record_category',
  'case_id',
  'case_version',
  'review_module',
  'unit_type',
  'unit_id',
  'nct_id',
  'descriptor_ui',
  'descriptor_name',
  'area',
  'determination_level',
  'reviewer_slot',
  'reviewer_pseudo_id',
  'decision_initial',
  'decision_effective_preclose',
  'n_revisions_preclose',
  'uncertain',
  'packet_issue_flag',
  'first_submitted_at',
  'last_submitted_at',
] as const;
export const ADJUDICATION_COLUMNS = [
  'export_id',
  'record_category',
  'case_id',
  'determination_level',
  'adjudication_id',
  'adjudicated_decision',
  'adjudication_status',
  'adjudication_basis',
  'disagreement_reason_code',
  'adjudicator_pseudo_id',
  'adjudicator_role',
  'adjudication_blinded',
  'adjudicator_exposed_to_index_labels',
  'post_unblinding_revision_exists',
  'adjudicated_at',
  'reference_lock_id',
] as const;
export const PREDICTION_COLUMNS = [
  'prediction_set_id',
  'record_category',
  'case_id',
  'frame_unit_id',
  'unit_type',
  'unit_id',
  'nct_id',
  'descriptor_ui',
  'area',
  'determination_level',
  'tier0_binary',
  'tier1_version',
  'tier1_status_raw',
  'tier1_binary',
  'stage_c_trial_status',
  'prediction_frozen_at',
  'selection_stratum',
  'variance_stratum',
  'variance_stratum_size',
  'selection_probability',
  'sampling_weight',
  'comparison_cell',
  'impact_tier',
  'policy_governed_neoplasm_GEN06',
  'provenance_audit_result',
] as const;
export const MANIFEST_KEYS_V4 = [
  'export_id',
  'export_type',
  'export_format_version',
  'mode',
  'review_module',
  'created_at',
  'app_git_sha',
  'db_schema_version',
  'is_synthetic_fixture',
  'reference_locked',
  'reference_lock_id',
  'reference_locked_at',
  'formal_phase_opened_at',
  'formal_phase_closed_at',
  'freeze_manifest_id',
  'freeze_manifest_sha256',
  'frozen_at',
  'frozen_sample_case_list_sha256',
  'frozen_prediction_set_sha256',
  'tier1_version_frozen',
  'ontology_version',
  'ontology_sha256',
  'tier1_decision_file_sha256',
  'tier0_mapping_sha256',
  'rubric_version',
  'rubric_sha256',
  'sampling_design_version',
  'provenance_audit_sha256',
  'extension_approved_by_amendment',
  'amendment_id',
  'adjudication_scope',
  'files',
] as const;

export interface V4DbQueryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface V4DbExportOptions {
  /** Commit identifying the running export build; supplied by the server/build environment. */
  appGitSha: string;
  exportId?: string;
  createdAt?: string;
  /** Optional assertions for callers migrating from the original override API. */
  dbSchemaVersion?: string;
  ontologyVersion?: string;
  rubricVersion?: string;
  samplingDesignVersion?: string;
  formalPhaseOpenedAt?: string;
}

const ISO_UTC_TS_SQL = (expr: string) =>
  `regexp_replace(to_char(${expr} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), '\\.0+$|(\\.\\d*?[1-9])0+$', '\\1') || 'Z'`;

/**
 * Query held-out prediction rows and their sampling design before `rpc_freeze_v4` locks the sample.
 * Uses the exact same column projection and text formatting as `v_frozen_predictions_v4` so the
 * pre-freeze file hash (`prediction_file_sha256`) matches the post-lock view export byte-for-byte.
 */
export async function queryV4PreFreezePredictionsFromDb(
  db: V4DbQueryable,
  predictionSetId?: string,
): Promise<V4Row[]> {
  const params = predictionSetId ? [predictionSetId] : [];
  const filter = predictionSetId ? 'and f.prediction_set_id = $1' : '';
  const { rows } = await db.query<V4Row>(
    `select
       f.prediction_set_id,
       r.record_category,
       f.case_id,
       r.frame_unit_id,
       c.unit_type,
       cd.unit_id,
       cd.nct_id,
       cd.descriptor_ui,
       cd.area,
       f.determination_level,
       f.tier0_binary,
       f.tier1_version,
       f.tier1_status_raw,
       f.tier1_binary,
       f.stage_c_trial_status,
       ${ISO_UTC_TS_SQL('f.imported_at')} as prediction_frozen_at,
       d3.selection_stratum,
       d3.variance_stratum,
       d3.variance_stratum_size::text as variance_stratum_size,
       d3.selection_probability::text as selection_probability,
       d3.sampling_weight::text as sampling_weight,
       d3.comparison_cell_v11 as comparison_cell,
       r.impact_tier,
       r.policy_governed_neoplasm_gen06 as "policy_governed_neoplasm_GEN06",
       r.provenance_audit_result
     from public.frozen_predictions_v4 f
     join public.case_records_v4 r on r.case_id = f.case_id
     join public.cases c on c.case_id = f.case_id and c.withdrawn_at is null
     join public.case_design cd on cd.case_id = f.case_id
     join public.case_design_v3 d3 on d3.case_id = f.case_id
     where r.record_category in ('HELDOUT_FORMAL', 'HELDOUT_EXTENSION_APPROVED')
       ${filter}
     order by f.case_id collate "C", f.determination_level collate "C"`,
    params,
  );
  return rows;
}

/**
 * Compute the exact SHA-256 of the rendered v4 prediction CSV from the database before `rpc_freeze_v4`.
 */
export async function computeV4PredictionFileSha256FromDb(
  db: V4DbQueryable,
  predictionSetId?: string,
): Promise<string> {
  const rows = await queryV4PreFreezePredictionsFromDb(db, predictionSetId);
  return sha256(renderV4SyntheticPredictions(rows));
}

/**
 * Execute both database-side v4 integrity RPCs (`rpc_verify_frozen_predictions_v4` and
 * `rpc_verify_judgment_snapshot_v4`) and return their exact verification flags and hashes.
 */
export async function verifyV4DatabaseIntegrity(db: V4DbQueryable): Promise<{
  frozenPredictionsMatch: boolean;
  judgmentSnapshotMatch: boolean;
  frozenPredictions: {
    matches: boolean;
    frozen_sha256: string | null;
    current_sha256: string | null;
  };
  judgmentSnapshot: {
    matches: boolean;
    snapshot_sha256: string | null;
    current_sha256: string | null;
    snapshot_rows: number | null;
    current_rows: number | null;
  };
}> {
  const fpRes = await db.query<{
    matches: boolean;
    frozen_sha256: string;
    current_sha256: string;
  }>(
    'select matches, frozen_sha256, current_sha256 from public.rpc_verify_frozen_predictions_v4()',
  );
  const jsRes = await db.query<{
    matches: boolean;
    snapshot_sha256: string;
    current_sha256: string;
    snapshot_rows: number;
    current_rows: number;
  }>(
    'select matches, snapshot_sha256, current_sha256, snapshot_rows, current_rows from public.rpc_verify_judgment_snapshot_v4()',
  );
  const fpRow = fpRes.rows[0];
  const jsRow = jsRes.rows[0];
  const frozenPredictionsMatch = Boolean(fpRow && fpRow.matches === true);
  const judgmentSnapshotMatch = Boolean(jsRow && jsRow.matches === true);
  return {
    frozenPredictionsMatch,
    judgmentSnapshotMatch,
    frozenPredictions: {
      matches: frozenPredictionsMatch,
      frozen_sha256: fpRow?.frozen_sha256 ?? null,
      current_sha256: fpRow?.current_sha256 ?? null,
    },
    judgmentSnapshot: {
      matches: judgmentSnapshotMatch,
      snapshot_sha256: jsRow?.snapshot_sha256 ?? null,
      current_sha256: jsRow?.current_sha256 ?? null,
      snapshot_rows: jsRow?.snapshot_rows ?? null,
      current_rows: jsRow?.current_rows ?? null,
    },
  };
}

/**
 * Load a complete `V4SyntheticExportInput` from the database views (`v_independent_judgments_v4`,
 * `v_adjudicated_reference_v4`, `v_frozen_predictions_v4`), freeze/lock metadata tables, and
 * database integrity RPCs (`rpc_verify_frozen_predictions_v4`, `rpc_verify_judgment_snapshot_v4`).
 */
export async function loadV4SyntheticExportInputFromDb(
  db: V4DbQueryable,
  options: V4DbExportOptions,
): Promise<V4SyntheticExportInput> {
  if (!/^[0-9a-f]{40}$/.test(options?.appGitSha ?? '') || /^0+$/.test(options.appGitSha)) {
    throw new Error('Export requires an explicit nonzero 40-character lowercase Git commit SHA');
  }
  const integrity = await verifyV4DatabaseIntegrity(db);

  const metaRes = await db.query<{
    freeze_manifest_id: string;
    design_version: string;
    tier1_version_frozen: string;
    adjudication_scope: string;
    frozen_sample_case_list_sha256: string;
    prediction_rows_sha256: string;
    frozen_prediction_set_sha256: string;
    frozen_items: Record<string, string>;
    extension_amendment_id: string | null;
    frozen_at: string;
    reference_lock_id: string | null;
    reference_locked_at: string | null;
    formal_phase_closed_at: string | null;
    formal_phase_opened_at: string | null;
    db_schema_version: string | null;
    sampling_design_version: string | null;
  }>(
    `select
       fm.freeze_id::text as freeze_manifest_id,
       fm.design_version,
       fm.tier1_version as tier1_version_frozen,
       fm.adjudication_scope,
       fm.case_list_sha256 as frozen_sample_case_list_sha256,
       fm.prediction_rows_sha256,
       fm.prediction_file_sha256 as frozen_prediction_set_sha256,
       fm.frozen_items,
       fm.extension_amendment_id,
       sm.sampling_design_version,
       ${ISO_UTC_TS_SQL('fm.frozen_at')} as frozen_at,
       rl.lock_id::text as reference_lock_id,
       case when rl.locked_at is not null then ${ISO_UTC_TS_SQL('rl.locked_at')} end as reference_locked_at,
       (
         select ${ISO_UTC_TS_SQL('max(pt.occurred_at)')}
         from public.review_phase_events pt
         where pt.event_type in ('FORMAL_CLOSED_COMPLETE', 'FORMAL_CLOSED_INCOMPLETE')
       ) as formal_phase_closed_at,
       (
         select ${ISO_UTC_TS_SQL('coalesce(min(a.assigned_at), fm.frozen_at)')}
         from public.assignments a
         where a.mode = 'FORMAL' and a.withdrawn_at is null
       ) as formal_phase_opened_at,
       (
         select v.version
         from public.app_schema_version v
         order by v.applied_at desc, v.version desc
         limit 1
       ) as db_schema_version
     from public.freeze_manifests_v4 fm
     left join public.reference_locks rl on rl.review_module = 'ONTOLOGY_AREA'
     left join public.sample_manifests sm on sm.review_module = 'ONTOLOGY_AREA'`,
  );

  const meta = metaRes.rows[0];
  if (!meta) {
    throw new Error('No v4 freeze manifest exists in the database');
  }

  const exportId = options.exportId ?? '00000000-0000-4000-8000-0000000000f4';
  const createdAt = options.createdAt ?? meta.reference_locked_at ?? new Date().toISOString();
  const frozenItems = meta.frozen_items ?? {};

  // A bundle names one ontology/rubric pair. Resolve that pair from the versions
  // actually attached to the frozen cases; unrelated later registrations cannot
  // change it, and a mixed/missing registration cannot be represented honestly.
  const registrations = await db.query<{
    case_id: string;
    version_set_id: string | null;
    ontology_version: string | null;
    rubric_version: string | null;
    ontology_sha256: string | null;
    rubric_sha256: string | null;
    predates_freeze: boolean | null;
  }>(
    `select r.case_id, cv.version_set_id, o.ontology_version, o.rubric_version,
       o.ontology_sha256, o.rubric_sha256,
       (cv.created_at <= fm.frozen_at and o.registered_at <= fm.frozen_at
        and o.frozen_at <= fm.frozen_at) as predates_freeze
     from public.case_records_v4 r
     join public.cases c on c.case_id = r.case_id and c.withdrawn_at is null
     cross join public.freeze_manifests_v4 fm
     left join lateral (
       select version_set_id, created_at from public.case_versions
       where case_id = r.case_id order by version desc limit 1
     ) cv on true
     left join public.ontology_versions o on o.version_set_id = cv.version_set_id
     where r.record_category in ('HELDOUT_FORMAL', 'HELDOUT_EXTENSION_APPROVED')
     order by r.case_id collate "C"`,
  );
  const registration = registrations.rows[0];
  if (
    !registration ||
    registrations.rows.some(
      (row) =>
        row.predates_freeze !== true ||
        !row.version_set_id?.trim() ||
        !row.ontology_version?.trim() ||
        !row.rubric_version?.trim() ||
        row.version_set_id !== registration.version_set_id ||
        row.ontology_version !== registration.ontology_version ||
        row.rubric_version !== registration.rubric_version ||
        row.ontology_sha256 !== registration.ontology_sha256 ||
        row.rubric_sha256 !== registration.rubric_sha256,
    ) ||
    sha256(registrations.rows.map((row) => row.case_id).join('\n')) !==
      meta.frozen_sample_case_list_sha256
  ) {
    throw new Error(
      'Frozen cases must share one complete ontology/rubric registration predating freeze',
    );
  }
  if (
    registration.ontology_sha256 !== frozenItems.ontology_sha256 ||
    registration.rubric_sha256 !== frozenItems.rubric_sha256
  ) {
    throw new Error('Frozen ontology/rubric hashes differ from the registered case versions');
  }
  if (!meta.db_schema_version?.trim() || !meta.sampling_design_version?.trim()) {
    throw new Error('Database schema and frozen sampling-design versions are required');
  }
  for (const [option, actual] of [
    ['dbSchemaVersion', meta.db_schema_version],
    ['ontologyVersion', registration.ontology_version],
    ['rubricVersion', registration.rubric_version],
    ['samplingDesignVersion', meta.sampling_design_version],
    ['formalPhaseOpenedAt', meta.formal_phase_opened_at],
  ] as const) {
    if (options[option] !== undefined && options[option] !== actual) {
      throw new Error(`Export ${option} assertion differs from frozen database provenance`);
    }
  }

  const freezeManifestCanonical = canonicalJson({
    freeze_id: meta.freeze_manifest_id,
    design_version: meta.design_version,
    tier1_version: meta.tier1_version_frozen,
    adjudication_scope: meta.adjudication_scope,
    case_list_sha256: meta.frozen_sample_case_list_sha256,
    prediction_rows_sha256: meta.prediction_rows_sha256,
    prediction_file_sha256: meta.frozen_prediction_set_sha256,
    frozen_items: frozenItems,
    extension_amendment_id: meta.extension_amendment_id ?? '',
    frozen_at: meta.frozen_at,
  });

  const judgmentsRes = await db.query<V4Row>(
    `select
       $1::text as export_id,
       v.record_category,
       v.case_id,
       v.case_version::text as case_version,
       v.review_module,
       v.unit_type,
       v.unit_id,
       v.nct_id,
       v.descriptor_ui,
       v.descriptor_name,
       v.area,
       v.determination_level,
       v.reviewer_slot::text as reviewer_slot,
       v.reviewer_pseudo_id,
       v.decision_initial,
       v.decision_effective_preclose,
       v.n_revisions_preclose::text as n_revisions_preclose,
       v.uncertain,
       v.packet_issue_flag,
       ${ISO_UTC_TS_SQL('v.first_submitted_at')} as first_submitted_at,
       ${ISO_UTC_TS_SQL('v.last_submitted_at')} as last_submitted_at
     from public.v_independent_judgments_v4 v
     order by v.case_id collate "C", v.determination_level collate "C", v.reviewer_slot`,
    [exportId],
  );

  const referenceRes = await db.query<V4Row>(
    `select
       $1::text as export_id,
       v.record_category,
       v.case_id,
       v.determination_level,
       v.adjudication_id,
       v.adjudicated_decision,
       v.adjudication_status,
       v.adjudication_basis,
       v.disagreement_reason_code,
       v.adjudicator_pseudo_id,
       v.adjudicator_role,
       v.adjudication_blinded,
       v.adjudicator_exposed_to_index_labels,
       v.post_unblinding_revision_exists,
       ${ISO_UTC_TS_SQL('v.adjudicated_at')} as adjudicated_at,
       v.reference_lock_id::text as reference_lock_id
     from public.v_adjudicated_reference_v4 v
     order by v.case_id collate "C", v.determination_level collate "C"`,
    [exportId],
  );

  const predictionsRes = await db.query<V4Row>(
    `select
       v.prediction_set_id,
       v.record_category,
       v.case_id,
       v.frame_unit_id,
       v.unit_type,
       v.unit_id,
       v.nct_id,
       v.descriptor_ui,
       v.area,
       v.determination_level,
       v.tier0_binary,
       v.tier1_version,
       v.tier1_status_raw,
       v.tier1_binary,
       v.stage_c_trial_status,
       ${ISO_UTC_TS_SQL('v.prediction_frozen_at')} as prediction_frozen_at,
       v.selection_stratum,
       v.variance_stratum,
       v.variance_stratum_size::text as variance_stratum_size,
       v.selection_probability::text as selection_probability,
       v.sampling_weight::text as sampling_weight,
       v.comparison_cell,
       v.impact_tier,
       v."policy_governed_neoplasm_GEN06",
       v.provenance_audit_result
     from public.v_frozen_predictions_v4 v
     order by v.case_id collate "C", v.determination_level collate "C"`,
  );

  const allCasesSynthetic =
    predictionsRes.rows.length > 0 &&
    predictionsRes.rows.every(
      (r) =>
        typeof r.case_id === 'string' &&
        /^HO4R?-TESTFX-\d+$/.test(r.case_id) &&
        (r.record_category === 'HELDOUT_FORMAL' ||
          r.record_category === 'HELDOUT_EXTENSION_APPROVED'),
    );

  const manifest: Record<string, unknown> = {
    export_id: exportId,
    export_type: 'ANALYSIS_BUNDLE',
    export_format_version: '4.0',
    mode: 'FORMAL',
    review_module: 'ONTOLOGY_AREA',
    created_at: createdAt,
    app_git_sha: options.appGitSha,
    db_schema_version: meta.db_schema_version,
    is_synthetic_fixture: allCasesSynthetic,
    reference_locked: Boolean(meta.reference_lock_id),
    reference_lock_id: meta.reference_lock_id ?? '',
    reference_locked_at: meta.reference_locked_at ?? '',
    formal_phase_opened_at: meta.formal_phase_opened_at,
    formal_phase_closed_at: meta.formal_phase_closed_at ?? '',
    freeze_manifest_id: meta.freeze_manifest_id,
    freeze_manifest_sha256: frozenItems.freeze_manifest_sha256 ?? sha256(freezeManifestCanonical),
    frozen_at: meta.frozen_at,
    frozen_sample_case_list_sha256: meta.frozen_sample_case_list_sha256,
    frozen_prediction_set_sha256: meta.frozen_prediction_set_sha256,
    tier1_version_frozen: meta.tier1_version_frozen,
    ontology_version: registration.ontology_version,
    ontology_sha256: registration.ontology_sha256,
    tier1_decision_file_sha256: frozenItems.tier1_decision_file_sha256 ?? '',
    tier0_mapping_sha256: frozenItems.tier0_mapping_sha256 ?? '',
    rubric_version: registration.rubric_version,
    rubric_sha256: registration.rubric_sha256,
    sampling_design_version: meta.sampling_design_version,
    provenance_audit_sha256: frozenItems.provenance_audit_sha256 ?? '',
    extension_approved_by_amendment: Boolean(meta.extension_amendment_id),
    amendment_id: meta.extension_amendment_id ?? '',
    adjudication_scope: meta.adjudication_scope,
  };

  return {
    manifest,
    independentJudgments: judgmentsRes.rows,
    adjudicatedReference: referenceRes.rows,
    frozenPredictions: predictionsRes.rows,
    integrity: {
      frozenPredictionsMatch: integrity.frozenPredictionsMatch,
      judgmentSnapshotMatch: integrity.judgmentSnapshotMatch,
    },
  };
}

/**
 * Load the locked synthetic v4 dataset and its database-verified integrity results directly
 * from the database views/RPCs and build the validated v4 export bundle.
 */
export async function exportV4SyntheticBundleFromDb(db: V4DbQueryable, options: V4DbExportOptions) {
  const input = await loadV4SyntheticExportInputFromDb(db, options);
  return buildV4SyntheticBundle(input);
}
