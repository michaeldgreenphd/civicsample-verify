"""Approved, offline descriptive comparison of completed AI and locked human answers.

No provider/key, clinical database, existing-ledger write, model selection or pooled
population estimate. CLI stdout contains the fixed count/hash allowlist only.
"""
from __future__ import annotations

from collections import Counter
import csv
from datetime import datetime, timezone
import io
import itertools
import json
import math
import os
from pathlib import Path

import runner as R
import check_live_comparability as C
import completed_runs as B
import locked_review as H

PLAN_FORMAT = 'civicsample-ai-sample-comparison-plan-1.0'
FAMILIES = ('AREA', 'ROW', 'SG')
PATTERNS = ('BOTH_AGREE', 'BOTH_DISAGREE', 'SPLIT', 'ONE_OR_TWO_CANNOT_TELL')
TRACE_COLUMNS = ('table', 'unit_id', 'family', 'category', 'model', 'reference', 'model_answer',
                 'reference_answer', 'pair_pattern', 'displayed_text_identical', 'packet_identical',
                 'changed_fields', 'request_sha256', 'reference_request_sha256')


def validate_plan(raw: bytes) -> dict:
    plan = R.keys(R.decode(raw), {'format', 'status', 'approved_at', 'approval_ref', 'protocol_sha256',
        'unresolved_reference', 'comparability_handling', 'screening_model_decision'})
    R.require(plan['format'] == PLAN_FORMAT and plan['status'] == 'APPROVED', 'analysis_approval_required')
    R.require(H.timestamp(plan['approved_at']) <= datetime.now(timezone.utc), 'invalid_approval_date')
    R.text(plan['approval_ref'], 200)
    R.require(R.HEX.fullmatch(str(plan['protocol_sha256'])) and
              plan['unresolved_reference'] == 'REPORT_SEPARATELY_EXCLUDE_FROM_AGREEMENT' and
              plan['comparability_handling'] == 'REPORT_PER_UNIT_COVARIATES', 'analysis_plan_mismatch')
    selection = R.keys(plan['screening_model_decision'], {'status', 'recorded_at', 'model'})
    # A later screening model must not be selected after inspecting human
    # agreement. A pending cohort decision does not implicitly waive that gate.
    R.require(selection['status'] in ('FIXED_BEFORE_HUMAN_EXPORT', 'NO_COHORT_SCREEN_PLANNED'),
              'screening_choice_required_before_human_export')
    R.require(H.timestamp(selection['recorded_at']) <= H.timestamp(plan['approved_at']),
              'screening_choice_after_analysis_approval')
    R.require(selection['model'] in R.MODELS if selection['status'] == 'FIXED_BEFORE_HUMAN_EXPORT'
              else selection['model'] is None, 'invalid_screening_choice')
    return plan


def pair_pattern(a: str, b: str) -> str:
    if 'CANNOT_TELL' in (a, b):
        return 'ONE_OR_TWO_CANNOT_TELL'
    return 'BOTH_'+a if a == b else 'SPLIT'


def validate_same_assignments(ai: dict, live: dict) -> None:
    original = {u['unit_id']: u for u in ai['units']}
    for u in live['units']:
        previous = original[u['unit_id']]
        R.require(all(u['packet']['unit'][k] == previous['packet']['unit'][k] for k in
                  ('family', 'category', 'unit_role', 'mapping_code', 'assignment_code', 'assignment_status')) and
                  u['subtype_required'] == previous['subtype_required'], 'assignment_task_changed')


def statistics(pairs: list[tuple[str, str]], family_n: int) -> dict:
    table = {(a, b): 0 for a in (*R.ANSWERS, 'MISSING') for b in R.ANSWERS}
    unresolved = Counter()
    for a, b in pairs:
        R.require(a in (*R.ANSWERS, 'MISSING') and b in (*R.ANSWERS, 'UNRESOLVED'), 'invalid_analysis_answer')
        if b == 'UNRESOLVED':
            unresolved[a] += 1
        else:
            table[a, b] += 1
    valid = [(a, b) for a, b in pairs if a in R.ANSWERS and b in R.ANSWERS]
    n = len(valid)
    equal = sum(a == b for a, b in valid)
    out = {'table': table, 'family_n': family_n, 'paired_n': n, 'equal': equal,
           'missing': sum(a == 'MISSING' for a, _ in pairs), 'unresolved': sum(unresolved.values()),
           'unresolved_by_model_answer': dict(unresolved), 'agreement': None, 'wilson': None, 'kappa': None}
    if family_n >= 20 and n:
        p, z = equal/n, 1.959963984540054
        den = 1+z*z/n
        center = (p+z*z/(2*n))/den
        half = z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den
        left, right = Counter(a for a, _ in valid), Counter(b for _, b in valid)
        expected = sum(left[c]*right[c] for c in R.ANSWERS)/(n*n)
        out.update(agreement=p, wilson=(max(0, center-half), min(1, center+half)),
                   kappa=(p-expected)/(1-expected) if expected < 1 else None)
    return out


def matrix_markdown(s: dict) -> list[str]:
    lines = ['| Model answer | Reference Agree | Reference Disagree | Reference Cannot tell |',
             '|---|---:|---:|---:|']
    for a in (*R.ANSWERS, 'MISSING'):
        lines.append('| '+a+' | '+' | '.join(str(s['table'][a, b]) for b in R.ANSWERS)+' |')
    t = s['table']
    lines += ['', f"Family units: {s['family_n']}; paired, resolved denominator: {s['paired_n']}; "
              f"equal answers: {s['equal']}; missing model outputs: {s['missing']}; unresolved reference: {s['unresolved']}.",
              f"Confirmations (Agree/Agree): {t['AGREE', 'AGREE']}; model Agree/reference Disagree: {t['AGREE', 'DISAGREE']}; "
              f"model Disagree/reference Agree: {t['DISAGREE', 'AGREE']}.",
              f"Cannot tell by model: {sum(t['CANNOT_TELL', b] for b in R.ANSWERS)}; "
              f"by reference (including missing model): {sum(t[a, 'CANNOT_TELL'] for a in (*R.ANSWERS, 'MISSING'))}."]
    if s['agreement'] is None:
        lines.append('Agreement interval and kappa withheld: fewer than 20 family units or no eligible pairs.')
    else:
        lo, hi = s['wilson']
        kappa = f"{s['kappa']:.6f}" if s['kappa'] is not None else 'undefined (degenerate marginals)'
        lines.append(f"Descriptive agreement: {100*s['agreement']:.4f}% (Wilson 95% {100*lo:.4f}%–{100*hi:.4f}%); "
                     f"Cohen’s kappa: {kappa}. Denominator: {s['paired_n']} observed, resolved pairs.")
    if s['unresolved']:
        lines += ['', 'Unresolved references, kept outside the 3 × 3 table and all agreement metrics:',
                  '| Model answer | Count |', '|---|---:|',
                  *[f"| {a} | {s['unresolved_by_model_answer'].get(a, 0)} |" for a in (*R.ANSWERS, 'MISSING')]]
    return lines


def analyze(ai: dict, ledger: dict, review: dict, comparability: tuple[dict, list[dict]],
            references: str, provenance: dict) -> tuple[str, str]:
    summary, covariates = comparability
    R.require(summary['unit_list_sha256_equal'] and summary['import_sha256_equal'], 'sample_freeze_mismatch')
    cov = {r['unit_id']: r for r in covariates}
    units = {u['unit_id']: u for u in ai['units']}
    records = {(r['model'], r['unit_id']): r for r in ledger['records']}
    latest = review['latest']
    trace, lines = [], ['# Sample comparison', '',
        'Descriptive agreement on the fixed displayed mappings. Both clinicians and models saw the assignment; '
        'these are confirmation tasks. Model consistency is not clinical validity. No model winner is selected.',
        'Families remain separate. No pooled or population-weighted estimate is computed. Unresolved adjudications '
        'are reported separately from Cannot tell and excluded from agreement metrics. Missing outputs remain distinct.',
        'The AI and human guide hashes and profiles are recorded below. The v8.4 completion-aware protocol locks completed independent answers '
        'and routes every Cannot tell pair to adjudication, including two Cannot tell answers. '
        'The separate diabetes stated-type question is never part of membership agreement.', '',
        '## Input bindings', '', '```json', json.dumps(provenance, indent=2, sort_keys=True), '```', '',
        '## Task comparability', '', '```json', json.dumps(summary, indent=2, sort_keys=True), '```', '',
        'Per-unit displayed-text and packet covariates appear on every row of numbers_trace.csv. '
        'The comparison is limited to the supplied captured fields; it does not certify unrecorded screen context.']

    def answer(model, uid):
        return records.get((model, uid), {}).get('answer', {}).get('answer', 'MISSING')

    def add_trace(table, uid, model, ref, a, b, pattern='', other_model=None):
        u = units[uid]['packet']['unit']
        trace.append({'table': table, 'unit_id': uid, 'family': u['family'], 'category': u['category'],
            'model': model, 'reference': ref, 'model_answer': a, 'reference_answer': b, 'pair_pattern': pattern,
            'displayed_text_identical': str(cov[uid]['displayed_text_identical']).lower(),
            'packet_identical': str(cov[uid]['packet_identical']).lower(),
            'changed_fields': '|'.join(cov[uid]['changed_fields']),
            'request_sha256': records.get((model, uid), {}).get('request_sha256', ''),
            'reference_request_sha256': records.get((other_model, uid), {}).get('request_sha256', '') if other_model else ''})

    for family in FAMILIES:
        ids = [uid for uid, u in units.items() if u['packet']['unit']['family'] == family]
        lines += ['', f'## {family} — {len(ids)} units']
        for model in R.MODELS:
            targets = []
            if references in ('R1', 'both'):
                targets += [(f'R1 reviewer {slot}', {uid: latest[(uid, slot)]['answer'] for uid in ids}) for slot in ('1', '2')]
            if references in ('R2', 'both'):
                R.require(review['adjudication_present'] and set(review['reference']) == set(units), 'adjudication_snapshot_required')
                targets += [('R2 adjudicated reference', review['reference'])]
            for name, values in targets:
                lines += ['', f'### {model} / {name}', '']
                pairs = [(answer(model, uid), values[uid]) for uid in ids]
                lines += matrix_markdown(statistics(pairs, len(ids)))
                for uid, (a, b) in zip(ids, pairs):
                    add_trace(f'{family}|{model}|{name}', uid, model, name, a, b)
            if references in ('R1', 'both'):
                pattern_counts = Counter()
                for uid in ids:
                    pattern = pair_pattern(latest[(uid, '1')]['answer'], latest[(uid, '2')]['answer'])
                    a = answer(model, uid)
                    pattern_counts[a, pattern] += 1
                    add_trace(f'{family}|{model}|R1 pair pattern', uid, model, 'R1 pair pattern', a, '', pattern)
                lines += ['', f'### {model} / R1 pair pattern', '',
                    '| Model answer | '+' | '.join(PATTERNS)+' |', '|---|---:|---:|---:|---:|']
                lines += ['| '+a+' | '+' | '.join(str(pattern_counts[a, p]) for p in PATTERNS)+' |'
                          for a in (*R.ANSWERS, 'MISSING')]
        for left, right in itertools.combinations(R.MODELS, 2):
            # The required original ledger is complete. Keep an explicit refusal
            # if an internal caller supplies a missing comparison-side model.
            pairs = [(answer(left, uid), answer(right, uid)) for uid in ids]
            R.require(all(b in R.ANSWERS for _, b in pairs), 'consistency_pair_missing')
            lines += ['', f'### Consistency only: {left} / {right}', '', *matrix_markdown(statistics(pairs, len(ids)))]
            for uid, (a, b) in zip(ids, pairs):
                add_trace(f'{family}|{left}|consistency|{right}', uid, left, right, a, b, other_model=right)

    lines += ['', '## Diabetes stated-type observations — counts only', '',
              'Only units where the original task required this separate question contribute. '
              'Not applicable units are excluded, never counted as Type 2 not stated.', '',
              '| Family | Category | Role | Required units | Type 2 stated | Type 2 not stated | Cannot tell from packet | Missing |',
              '|---|---|---|---:|---:|---:|---:|---:|']
    subtype_groups = sorted({(u['packet']['unit']['family'], u['packet']['unit']['category'])
                             for u in units.values() if u['subtype_required']})
    for family, category in subtype_groups:
        ids = [uid for uid, u in units.items() if u['subtype_required'] and
               (u['packet']['unit']['family'], u['packet']['unit']['category']) == (family, category)]
        for role in (*R.MODELS, 'reviewer 1', 'reviewer 2'):
            values = []
            for uid in ids:
                if role in R.MODELS:
                    v = records.get((role, uid), {}).get('answer', {}).get('diabetes_subtype') or 'MISSING'
                else:
                    v = latest[(uid, role[-1])]['diabetes_subtype'] or 'MISSING'
                values.append(v)
                add_trace(f'{family}|{category}|{role}|diabetes stated type', uid, role, 'separate observation', v, '')
            counts = Counter(values)
            lines.append(f'| {family} | {category} | {role} | {len(ids)} | '+
                         ' | '.join(str(counts[x]) for x in (*R.SUBTYPES, 'MISSING'))+' |')
    if not subtype_groups:
        lines.append('No unit in this input required a stated-type observation.')
    stream = io.StringIO(newline='')
    writer = csv.DictWriter(stream, fieldnames=TRACE_COLUMNS, lineterminator='\n')
    writer.writeheader()
    writer.writerows(trace)
    trace_text = stream.getvalue()
    lines += ['', 'Numbers-trace SHA-256: '+R.sha(trace_text.encode())]
    return '\n'.join(lines)+'\n', trace_text


def write_report(parent: Path, report: str, trace: str) -> str:
    R.require(parent.is_absolute() and parent.is_dir() and
              not any(p.is_symlink() for p in (parent, *parent.parents)) and
              not any((p / '.git').exists() for p in (parent, *parent.parents)), 'unsafe_output')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    # A new directory prevents overwriting an earlier comparison or either ledger.
    destination = parent / ('comparison-'+stamp)
    destination.mkdir(mode=0o700)
    for name, value in ((f'SAMPLE_COMPARISON_REPORT_{stamp}.md', report), ('numbers_trace.csv', trace)):
        with os.fdopen(os.open(destination/name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as f:
            f.write(value.encode())
            f.flush()
            os.fsync(f.fileno())
    return R.sha(report.encode())


def main() -> None:
    p = R.QuietParser(description=__doc__)
    for name in ('ai-input', 'ai-sha256', 'ledger', 'ledger-sha256', 'live-snapshot', 'live-sha256',
                 'review-bundle', 'manifest-sha256', 'review-closure', 'closure-sha256',
                 'analysis-plan', 'plan-sha256', 'private-output'):
        p.add_argument('--'+name, required=True)
    p.add_argument('--references', choices=('R1', 'R2', 'both'), default='both')
    p.add_argument('--adjudication-sha256')
    a = p.parse_args()
    # The investigator's scientific gate is checked before opening human material.
    plan = validate_plan(C.read_private(a.analysis_plan, a.plan_sha256))
    R.require((a.references == 'R1') == (a.adjudication_sha256 is None), 'adjudication_snapshot_required')
    ai = R.validate_bundle(C.read_private(a.ai_input, a.ai_sha256), a.ai_sha256)
    ledger = B.mapping_records(ai, C.read_private(a.ledger, a.ledger_sha256), a.ledger_sha256, a.ai_sha256)
    live = C.validate_live(C.read_private(a.live_snapshot, a.live_sha256), a.live_sha256)
    comparability = C.compare(ai, live)
    R.require(comparability[0]['unit_list_sha256_equal'] and comparability[0]['import_sha256_equal'], 'sample_freeze_mismatch')
    validate_same_assignments(ai, live)
    closure = R.decode(C.read_private(a.review_closure, a.closure_sha256))
    review = H.load(Path(a.review_bundle), a.manifest_sha256, live, adjudication_digest=a.adjudication_sha256,
                    approved_at=plan['approved_at'], closure=closure)
    provenance = {'ai_input_sha256': a.ai_sha256, 'ledger_sha256': a.ledger_sha256,
        'live_snapshot_sha256': a.live_sha256, 'review_manifest_sha256': a.manifest_sha256,
        'review_closure_sha256': a.closure_sha256,
        'adjudication_snapshot_sha256': a.adjudication_sha256, 'analysis_plan_sha256': a.plan_sha256,
        'protocol_sha256': plan['protocol_sha256'], 'approval_ref': plan['approval_ref'],
        'references': a.references, 'guide_ai_profile': ai['guide']['profile_id'], 'guide_live_profile': live['guide']['profile_id'],
        'guide_ai_sha256': ai['guide']['sha256'], 'guide_live_sha256': live['guide']['sha256']}
    report, trace = analyze(ai, ledger, review, comparability, a.references, provenance)
    report_digest = write_report(Path(a.private_output), report, trace)
    print(json.dumps({'units': len(ai['units']), 'models': len(R.MODELS),
        'families': len({u['packet']['unit']['family'] for u in ai['units']}),
        'reviewers_finished': True, 'adjudication_present': review['adjudication_present'],
        'report_sha256': report_digest}, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except R.Refused as error:
        print(json.dumps({'status': 'refused', 'category': str(error)}))
        raise SystemExit(2) from None
    except Exception:
        print(json.dumps({'status': 'refused', 'category': 'unexpected_failure'}))
        raise SystemExit(2) from None
