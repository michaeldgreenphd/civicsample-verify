"""Offline join of an unchanged 100-packet comparison and complete original label sources.

Read-only inputs; creates one new private file outside every checkout. It does not draw a
sample, approve a rubric, infer new labels, load a database or call a provider.
"""
from __future__ import annotations

import csv
import io
import json
import os
from pathlib import Path

import label_pilot as P
import runner as R

AREA_COLUMNS = {
    'ONCOLOGY': 'oncology', 'CARDIOVASCULAR': 'cardio', 'MENTAL_HEALTH': 'mental_health',
    'INFECTIOUS': 'infectious', 'METABOLIC': 'metabolic', 'NEUROLOGICAL': 'neuro',
    'RESPIRATORY': 'respiratory', 'PATHOLOGICAL': 'pathological', 'IMMUNE': 'immune', 'UROGENITAL': 'urogenital',
}
ROW_NAMES = {'Cancer & Neoplasms (All)': 'CAN_ALL', 'Diabetes Mellitus': 'DIAB', 'Depression': 'DEP',
    'Obesity': 'OBE', 'Asthma': 'AST', 'Pulmonary Disease, Chronic Obstructive': 'COPD', 'COVID-19': 'COV',
    'Schizophrenia': 'SCZ', 'Hypertension': 'HTN', 'Pain': 'PAIN'}


def csv_rows(raw: bytes, required: set[str]) -> list[dict]:
    reader = csv.DictReader(io.StringIO(raw.decode('utf-8-sig')))
    R.require(reader.fieldnames and len(set(reader.fieldnames)) == len(reader.fieldnames) and
              required <= set(reader.fieldnames), 'source_columns_missing')
    rows = list(reader)
    R.require(all(None not in r and all(v is not None for v in r.values()) for r in rows), 'source_row_invalid')
    return rows


def unique_index(rows: list[dict]) -> dict:
    out = {}
    for r in rows:
        key = R.text(r['nct_id'], 100)
        R.require(key not in out, 'duplicate_source_trial')
        out[key] = r
    return out


def prepare(comparison_raw: bytes, comparison_sha: str, baseline_raw: bytes, baseline_sha: str,
            sources: dict[str, bytes]) -> dict:
    original = R.validate_bundle(comparison_raw, comparison_sha)
    R.require(R.sha(baseline_raw) == baseline_sha, 'baseline_digest_mismatch')
    R.require(set(sources) == P.SOURCES, 'source_columns_missing')
    trials = {u['packet']['trial']['nct_id'] for u in original['units']}
    R.require(len(trials) == 100, 'duplicate_trial')
    area = unique_index(csv_rows(sources['area_flags'], {'nct_id'} | {'v54_is_' + v for v in AREA_COLUMNS.values()}))
    R.require(trials <= area.keys(), 'missing_area_trial')
    memberships = {uid: set() for uid in trials}
    for uid in trials:
        for code, column in AREA_COLUMNS.items():
            flag = area[uid]['v54_is_' + column]
            R.require(flag in ('TRUE', 'FALSE'), 'invalid_area_flag')
            if flag == 'TRUE':
                memberships[uid].add('AREA_' + code)
    rules = {}
    for name, code in [('diabetes_rules', 'DIAB'), ('neoplasm_rules', 'CAN_ALL')]:
        rules[code] = unique_index(csv_rows(sources[name], {'nct_id', 'rule_status'}))
        R.require(all(r['rule_status'] in ('KEEP', 'REMOVE') for r in rules[code].values()), 'invalid_rule_status')
    seen, positive, relevant = set(), set(), set()
    for row in csv_rows(sources['condition_map'], {'nct_id', 'condition_category'}):
        uid, name = row['nct_id'], row['condition_category']
        if uid not in trials:
            continue
        seen.add(uid)
        if name not in ROW_NAMES:
            continue
        code = ROW_NAMES[name]
        R.require((uid, code) not in relevant, 'duplicate_condition_assignment')
        relevant.add((uid, code))
        if code in rules:
            R.require(uid in rules[code], 'missing_rule_trial')
            if rules[code][uid]['rule_status'] == 'REMOVE':
                continue
        memberships[uid].add('ROW_' + code)
        positive.add((uid, code))
    R.require(seen == trials, 'missing_condition_trial')
    # Reconcile positive membership to the final model frame. Do not infer absent
    # labels from that eligibility-filtered frame: the complete condition map above
    # also covers subgroup trials omitted from the model by the exclusion rules.
    frame_rows = csv_rows(sources['condition_frame'], {'nct_id', 'row_id'})
    frame = [(r['nct_id'], r['row_id']) for r in frame_rows if r['nct_id'] in trials]
    R.require(len(set(frame)) == len(frame) and set(frame) == positive, 'condition_frame_mismatch')
    for code, rule in rules.items():
        R.require({(uid, code) for uid in trials if uid in rule} == {p for p in relevant if p[1] == code},
                  'rule_membership_mismatch')
    bundle = {'format': P.FORMAT, 'comparison_input': comparison_raw.decode(),
              'baseline': {'input_sha256': comparison_sha, 'ledger_sha256': baseline_sha},
              'source_sha256': {key: R.sha(raw) for key, raw in sources.items()},
              'memberships': [{'unit_id': u['unit_id'], 'original_labels': sorted(memberships[u['packet']['trial']['nct_id']])}
                              for u in original['units']]}
    raw = R.encode(bundle)
    P.validate_bundle(raw, R.sha(raw))
    P.verify_baseline(bundle, baseline_raw)
    return bundle


def private_path(value: str, *, exists: bool) -> Path:
    path = Path(value)
    R.require(path.is_absolute() and not path.is_symlink(), 'unsafe_path')
    resolved = path.resolve()
    R.require(not any((p / '.git').exists() for p in resolved.parents), 'unsafe_path')
    R.require(path.is_file() if exists else (not path.exists() and path.parent.is_dir()), 'unsafe_path')
    return path


def main() -> None:
    parser = R.QuietParser(description='Build a private exploratory input; offline and no overwrite.')
    for name in ('comparison', 'comparison-sha256', 'baseline', 'baseline-sha256', 'output',
                 'area-flags', 'condition-map', 'diabetes-rules', 'neoplasm-rules', 'condition-frame'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    bundle = prepare(private_path(args.comparison, exists=True).read_bytes(), args.comparison_sha256,
                     private_path(args.baseline, exists=True).read_bytes(), args.baseline_sha256,
                     {k: private_path(getattr(args, k), exists=True).read_bytes() for k in P.SOURCES})
    output = private_path(args.output, exists=False)
    raw = R.encode(bundle)
    with os.fdopen(os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as file:
        file.write(raw)
        file.flush()
        os.fsync(file.fileno())
    print(json.dumps({'status': 'prepared', 'trials': 100, 'labels_per_trial': 20,
                      'original_labels': sum(len(u['original_labels']) for u in bundle['memberships']), 'paid_requests': 0}))


if __name__ == '__main__':
    try:
        main()
    except R.Refused as error:
        print(json.dumps({'status': 'refused', 'category': str(error)}))
        raise SystemExit(2) from None
    except Exception:
        print(json.dumps({'status': 'refused', 'category': 'unexpected_failure'}))
        raise SystemExit(2) from None
