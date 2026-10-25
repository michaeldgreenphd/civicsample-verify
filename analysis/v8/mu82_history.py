"""Independently reconstruct stored per-revision and snapshot hashes (bundle 8.2).

All input is downloaded CSV, never database access. No clinical policy is inferred.
"""
from __future__ import annotations
import csv
import datetime as dt
import hashlib
import io
import re

COLUMNS = ['unit_id', 'mode', 'assignment_id', 'reviewer_slot', 'reviewer_pseudo_id',
           'revision_number', 'answer', 'reason_code', 'note', 'uncertain', 'seconds_on_unit',
           'diabetes_subtype', 'content_sha256', 'submitted_at_utc']


REASONS = {'ORGAN_OF_ORIGIN_ONLY', 'NOT_THE_CONDITION_STUDIED', 'MESH_PLACEMENT_MISLEADING',
           'RUBRIC_POLICY_EXCLUDES', 'OTHER_SPECIFIED', 'TYPE_1_ONLY', 'OTHER_DIABETES_TYPE',
           'PREDIABETES_ONLY', 'DIABETES_NOT_STUDIED', 'TYPE_2_STATED', 'TYPE_2_STUDIED',
           'TYPE_NOT_DETERMINABLE', 'DIABETES_STUDIED', 'BENIGN_NEOPLASM', 'PRECANCEROUS',
           'NOT_A_NEOPLASM', 'MALIGNANT_NEOPLASM_STUDIED'}


def sha(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def verify(path, man, judgments, require, reason_validator=None):
    def check(ok):
        require(ok, 'judgment history differs from its locked snapshot or export contract')
    check(man.get('history_contract_version') == 'mu81-history-1')
    name = 'judgment_history.csv'
    check((path / name).is_file())
    raw = (path / name).read_bytes()
    check(hashlib.sha256(raw).hexdigest() == man['files'].get(name))
    reader = csv.DictReader(io.StringIO(raw.decode('utf-8'), newline=''))
    check(reader.fieldnames == COLUMNS)
    history = list(reader)
    check(len(history) == man['row_counts'].get(name))
    with (path / 'subtype_observations.csv').open(encoding='utf-8', newline='') as f:
        subtypes = list(csv.DictReader(f))
    def key(r):
        return r['unit_id'], r['reviewer_slot']
    def rev(r):
        return *key(r), r['revision_number']
    def integer(v, minimum):
        return re.fullmatch(r'0|[1-9][0-9]*', v) and minimum <= int(v) <= 2147483647
    def fields(r, columns):
        return '|'.join(r[k] for k in columns)
    observations = {rev(r): r for r in subtypes}
    check(len(observations) == len(subtypes))
    groups, assignments = {}, {}
    for r in history:
        check(set(r) == set(COLUMNS) and all(isinstance(v, str) for v in r.values()))
        check(r['mode'] == 'FORMAL' and re.fullmatch(r'[A-Za-z0-9_-]+', r['unit_id']))
        check(r['reviewer_slot'] in ('1', '2') and integer(r['revision_number'], 1))
        check(re.fullmatch(r'[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}', r['assignment_id']))
        check(r['answer'] in ('AGREE', 'DISAGREE', 'CANNOT_TELL'))
        check(re.fullmatch(r'R-[A-Z0-9]{4}', r['reviewer_pseudo_id']))
        if reason_validator is not None:
            check(reason_validator(r['unit_id'], r['answer'], r['reason_code']))
        else:
            check(r['reason_code'] in REASONS if r['answer'] == 'DISAGREE' else r['reason_code'] == '')
        check(r['uncertain'] in ('true', 'false'))
        check(r['seconds_on_unit'] == '' or integer(r['seconds_on_unit'], 0))
        check(r['diabetes_subtype'] in ('', 'TYPE_2_STATED', 'TYPE_2_NOT_STATED', 'CANNOT_TELL_FROM_PACKET'))
        check(re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z', r['submitted_at_utc']))
        try:
            dt.datetime.strptime(r['submitted_at_utc'], '%Y-%m-%dT%H:%M:%S.%fZ')
        except ValueError:
            check(False)
        base = sha(fields(r, ['assignment_id', 'revision_number', 'answer', 'reason_code', 'note', 'uncertain', 'seconds_on_unit']))
        check(sha('mu81-judgment-1|' + base + '|' + r['diabetes_subtype']) == r['content_sha256'])
        s = observations.pop(rev(r), None)
        check(s is not None and all(s[k] == r[k] for k in ('mode', 'answer', 'diabetes_subtype', 'content_sha256')))
        check(r['assignment_id'] not in assignments or assignments[r['assignment_id']] == key(r))
        assignments[r['assignment_id']] = key(r)
        groups.setdefault(key(r), []).append(r)
    check(not observations)
    seen = set()
    for j in judgments.to_dict('records'):
        k = key(j)
        check(j['mode'] == 'FORMAL' and k not in seen)
        seen.add(k)
        rows = sorted(groups.pop(k, []), key=lambda r: int(r['revision_number']))
        if j['judgment_status'] == 'NOT_ANSWERED':
            check(not rows)
            continue
        check(j['judgment_status'] == 'ANSWERED' and integer(j['n_revisions'], 0))
        check(len(rows) == int(j['n_revisions']) + 1)
        check(all(int(r['revision_number']) == i+1 and r['reviewer_pseudo_id'] == j['reviewer_pseudo_id']
                  and r['assignment_id'] == rows[0]['assignment_id'] for i, r in enumerate(rows)))
        for r, suffix, time in ((rows[0], 'initial', 'first_submitted_at'), (rows[-1], 'effective', 'last_submitted_at')):
            check(all(r[a] == j[b+'_'+suffix] for a, b in (('answer', 'answer'), ('reason_code', 'reason'), ('note', 'note'), ('uncertain', 'uncertain'))))
            check(r['submitted_at_utc'][:23] + 'Z' == j[time])
    check(not groups)
    ordered = sorted(history, key=lambda r: (r['unit_id'], int(r['reviewer_slot']), int(r['revision_number'])))
    body = '\n'.join(fields(r, ['unit_id', 'reviewer_slot', 'reviewer_pseudo_id', 'revision_number', 'answer', 'reason_code', 'note', 'uncertain', 'content_sha256', 'submitted_at_utc']) for r in ordered)
    snapshot = man.get('snapshot')
    check(isinstance(snapshot, dict) and type(snapshot.get('n_rows')) is int)
    check(snapshot['n_rows'] == len(history) and snapshot.get('content_sha256') == sha(body))
