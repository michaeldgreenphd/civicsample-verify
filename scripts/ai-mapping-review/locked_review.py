"""Strict, read-only adapter for the clinician app's completion-aware v8.4 export.

No app imports, database connection, network access or fallback to interim answers.
Only files needed for the unweighted sample comparison are consumed. Sampling
weights and the app's population confirmation estimator are intentionally not used.
"""
from __future__ import annotations

import csv
from datetime import datetime, timedelta
import io
from pathlib import Path
import re

import runner as R
from check_live_comparability import read_private


def timestamp(value: str) -> datetime:
    try:
        t = datetime.fromisoformat(value.replace('Z', '+00:00'))
        R.require(t.tzinfo is not None, 'invalid_review_timestamp')
        return t
    except (ValueError, AttributeError):
        raise R.Refused('invalid_review_timestamp') from None


def hash_text(text: str) -> str:
    return R.sha(text.encode())


def csv_rows(raw: bytes) -> list[dict]:
    reader = csv.DictReader(io.StringIO(raw.decode('utf-8'), newline=''))
    R.require(reader.fieldnames and len(reader.fieldnames) == len(set(reader.fieldnames)), 'invalid_review_csv')
    rows = list(reader)
    R.require(all(None not in r and all(isinstance(v, str) for v in r.values()) for r in rows), 'invalid_review_csv')
    return rows


def load(root: Path, manifest_digest: str, live: dict, *, adjudication_digest: str | None = None,
         approved_at: str | None = None, closure: dict | None = None) -> dict:
    manifest = R.decode(read_private(str(root / 'manifest.json'), manifest_digest))
    R.require(isinstance(manifest, dict) and manifest.get('bundle_format_version') == '8.4' and
              manifest.get('mode') == 'FORMAL' and manifest.get('status') == 'FORMAL', 'completion_export_required')
    files, counts = manifest.get('files'), manifest.get('row_counts')
    R.require(isinstance(files, dict) and isinstance(counts, dict), 'invalid_review_manifest')
    # Gate before opening ANY judgment/history/reference file. Receipt presence
    # alone is not enough: validate both slots and completion metadata first.
    for name in ('review_completions.csv', 'completion_protocol.json', 'reviewer_guide_current.md'):
        R.require(name in files, 'completion_receipts_required')

    def raw(name):
        R.require(name in files, 'review_file_missing')
        return read_private(str(root / name), files[name])

    def rows(name):
        result = csv_rows(raw(name))
        R.require(type(counts.get(name)) is int and counts[name] == len(result), 'review_row_count_mismatch')
        return result

    receipts = rows('review_completions.csv')
    R.require(len(receipts) == 2 and {r.get('reviewer_slot') for r in receipts} == {'1', '2'} and
              len({r.get('reviewer_pseudo_id') for r in receipts}) == 2 and
              all(r.get('mode') == 'FORMAL' and r.get('answer_count') == '100' and r.get('finished_at')
                  for r in receipts), 'completion_receipts_required')
    protocol = R.decode(raw('completion_protocol.json'))
    guide = raw('reviewer_guide_current.md')
    freeze, profile = manifest.get('freeze'), manifest.get('reviewer_profile')
    R.require(isinstance(freeze, dict) and isinstance(profile, dict), 'review_freeze_required')
    R.require(protocol.get('mode') == 'FORMAL' and protocol.get('protocol_id') == 'mu84-finish-and-adjudicate-1' and
              protocol.get('guide_sha256') == R.sha(guide) == live['guide']['sha256'] and
              protocol.get('base_profile_sha256') == profile.get('binding_sha256'), 'completion_binding_mismatch')
    binding = hash_text('|'.join(['mu84-completion-binding-1', 'FORMAL', protocol['protocol_id'],
                                 protocol['base_profile_sha256'], protocol['guide_sha256']]))
    R.require(binding == protocol.get('binding_sha256') == freeze.get('completion_protocol_sha256'),
              'completion_binding_mismatch')
    for r in receipts:
        timestamp(r['finished_at'])
        R.require(r.get('protocol_binding_sha256') == binding and
                  hash_text(r.get('answers_text', '')) == r.get('answers_sha256') and
                  hash_text('|'.join(['mu84-completion-receipt-1', 'FORMAL', r['reviewer_pseudo_id'],
                                     binding, r['answers_sha256']])) == r.get('receipt_sha256'),
                  'completion_receipt_mismatch')
    snapshot = manifest.get('snapshot')
    R.require(isinstance(snapshot, dict) and manifest.get('history_contract_version') == 'mu81-history-1',
              'locked_judgment_snapshot_required')
    # The actual v8.4 export includes only n_rows/content_sha256 in snapshot.
    # Never invent a taken_at field in that bundle. A separately pinned,
    # answer-free lifecycle receipt supplies the closure chronology.
    closed = None
    if closure is not None:
        R.keys(closure, {'format', 'unit_list_sha256', 'snapshot_sha256', 'completion_protocol_sha256',
                         'closed_at', 'snapshot_taken_at'})
        R.require(closure['format'] == 'civicsample-review-closure-1.0' and
                  closure['unit_list_sha256'] == freeze.get('unit_list_sha256') and
                  closure['snapshot_sha256'] == snapshot.get('content_sha256') and
                  closure['completion_protocol_sha256'] == binding, 'review_closure_mismatch')
        closed = timestamp(closure['closed_at'])
        R.require(timestamp(closure['snapshot_taken_at']) >= closed and
                  all(timestamp(r['finished_at']) <= closed for r in receipts), 'review_close_precedes_completion')
    if approved_at is not None:
        R.require(closed is not None, 'review_closure_required')
        R.require(timestamp(approved_at) <= closed, 'analysis_approval_after_review_close')
    if adjudication_digest is not None:
        R.require(files.get('final_reference.csv') == adjudication_digest and
                  manifest.get('reference_locked_at') and manifest.get('n_units_locked') == 100,
                  'adjudication_snapshot_required')
        locked = timestamp(manifest['reference_locked_at'])
        R.require(locked >= (timestamp(closure['snapshot_taken_at']) if closure is not None else
                            max(timestamp(r['finished_at']) for r in receipts)), 'reference_lock_precedes_close')

    expected = {u['unit_id']: u for u in live['units']}
    units = rows('units.csv')
    R.require(len(units) == len(expected) and {u.get('unit_id') for u in units} == expected.keys(), 'review_sample_mismatch')
    R.require(hash_text('\n'.join(sorted(expected))) == freeze.get('unit_list_sha256') ==
              live['freeze']['unit_list_sha256'], 'review_sample_mismatch')
    for u in units:
        e = expected[u['unit_id']]['packet']['unit']
        R.require(u.get('mode') == 'FORMAL' and all(u.get(k) == e[k] for k in
                  ('family', 'category', 'unit_role', 'mapping_code', 'assignment_code', 'assignment_status')),
                  'review_assignment_mismatch')
        R.require(u.get('packet_sha256') == expected[u['unit_id']]['stored_packet_sha256'], 'review_packet_mismatch')
    judgments = rows('independent_judgments.csv')
    R.require(len(judgments) == 200 and
              {(j.get('unit_id'), j.get('reviewer_slot')) for j in judgments} ==
              {(u, s) for u in expected for s in ('1', '2')}, 'review_judgments_incomplete')
    history, observations = rows('judgment_history.csv'), rows('subtype_observations.csv')
    groups, revision_keys, assignments = {}, set(), {}
    obs = {(r['unit_id'], r['reviewer_slot'], r['revision_number']): r for r in observations}
    R.require(len(obs) == len(observations), 'judgment_history_mismatch')
    for r in history:
        uid, slot, revision = r['unit_id'], r['reviewer_slot'], r['revision_number']
        key = (uid, slot, revision)
        R.require(uid in expected and slot in ('1', '2') and key not in revision_keys and
                  re.fullmatch(r'[1-9][0-9]*', revision) and r['mode'] == 'FORMAL' and
                  r['answer'] in R.ANSWERS and r['uncertain'] in ('true', 'false'), 'judgment_history_mismatch')
        revision_keys.add(key)
        allowed = {x['code'] for x in expected[uid]['reason_codes']}
        R.require(r['reason_code'] in allowed if r['answer'] == 'DISAGREE' else r['reason_code'] == '',
                  'judgment_history_mismatch')
        R.require(r['diabetes_subtype'] in R.SUBTYPES if expected[uid]['subtype_required']
                  else r['diabetes_subtype'] == '', 'judgment_subtype_mismatch')
        timestamp(r['submitted_at_utc'])
        base = hash_text('|'.join(r[k] for k in ('assignment_id', 'revision_number', 'answer',
                                               'reason_code', 'note', 'uncertain', 'seconds_on_unit')))
        R.require(hash_text('mu81-judgment-1|' + base + '|' + r['diabetes_subtype']) == r['content_sha256'],
                  'judgment_history_mismatch')
        o = obs.pop(key, None)
        R.require(o is not None and all(o.get(k) == r[k] for k in ('mode', 'answer', 'diabetes_subtype', 'content_sha256')),
                  'judgment_history_mismatch')
        group = (uid, slot)
        R.require(assignments.get(r['assignment_id'], group) == group, 'judgment_history_mismatch')
        assignments[r['assignment_id']] = group
        groups.setdefault(group, []).append(r)
    R.require(not obs, 'judgment_history_mismatch')
    latest = {}
    for j in judgments:
        key = (j['unit_id'], j['reviewer_slot'])
        revisions = sorted(groups.pop(key, []), key=lambda r: int(r['revision_number']))
        R.require(j.get('mode') == 'FORMAL' and j.get('judgment_status') == 'ANSWERED' and
                  revisions and int(j['n_revisions']) + 1 == len(revisions), 'judgment_history_mismatch')
        for i, r in enumerate(revisions):
            R.require(int(r['revision_number']) == i + 1 and r['reviewer_pseudo_id'] == j['reviewer_pseudo_id'] and
                      r['assignment_id'] == revisions[0]['assignment_id'] and
                      (i == 0 or timestamp(revisions[i-1]['submitted_at_utc']) <= timestamp(r['submitted_at_utc'])),
                      'judgment_history_mismatch')
        for r, suffix, time in ((revisions[0], 'initial', 'first_submitted_at'),
                                (revisions[-1], 'effective', 'last_submitted_at')):
            R.require(all(r[a] == j[b+'_'+suffix] for a, b in
                      (('answer', 'answer'), ('reason_code', 'reason'), ('note', 'note'), ('uncertain', 'uncertain'))) and
                      timestamp(r['submitted_at_utc']).replace(microsecond=timestamp(r['submitted_at_utc']).microsecond // 1000 * 1000)
                      == timestamp(j[time]), 'judgment_history_mismatch')
        latest[key] = revisions[-1]
    R.require(not groups, 'judgment_history_mismatch')
    ordered = sorted(history, key=lambda r: (r['unit_id'], int(r['reviewer_slot']), int(r['revision_number'])))
    body = '\n'.join('|'.join(r[k] for k in ('unit_id', 'reviewer_slot', 'reviewer_pseudo_id', 'revision_number',
        'answer', 'reason_code', 'note', 'uncertain', 'content_sha256', 'submitted_at_utc')) for r in ordered)
    R.require(type(snapshot.get('n_rows')) is int and snapshot['n_rows'] == len(history) and
              snapshot.get('content_sha256') == hash_text(body), 'judgment_snapshot_mismatch')
    for receipt in receipts:
        chosen = [latest[(u, receipt['reviewer_slot'])] for u in sorted(expected)]
        txt = '\n'.join('|'.join(r[k] for k in ('unit_id', 'reviewer_slot', 'assignment_id',
                                               'revision_number', 'content_sha256')) for r in chosen)
        R.require(txt == receipt['answers_text'] and all(r['reviewer_pseudo_id'] == receipt['reviewer_pseudo_id'] and
                  timestamp(r['submitted_at_utc']) <= timestamp(receipt['finished_at']) + timedelta(milliseconds=1)
                  for r in chosen), 'completion_receipt_mismatch')

    reference = {}
    if adjudication_digest is not None:
        finals, flags = rows('final_reference.csv'), rows('final_answer_flags.csv')
        R.require(len(finals) == len(flags) == 100 and {f['unit_id'] for f in finals} == expected.keys() and
                  {f['unit_id'] for f in flags} == expected.keys(), 'adjudication_snapshot_mismatch')
        flags = {f['unit_id']: f for f in flags}
        for f in finals:
            uid = f['unit_id']
            a, b = latest[(uid, '1')]['answer'], latest[(uid, '2')]['answer']
            R.require(all(f.get(k) == expected[uid]['packet']['unit'][k] for k in
                      ('family', 'category', 'unit_role', 'mapping_code', 'assignment_code', 'assignment_status')),
                      'adjudication_assignment_mismatch')
            R.require(f.get('mode') == 'FORMAL' and f.get('answer_effective_slot1') == a and
                      f.get('answer_effective_slot2') == b and flags[uid].get('mode') == 'FORMAL' and
                      flags[uid].get('both_final_cannot_tell') == str(a == b == 'CANNOT_TELL').lower(),
                      'adjudication_snapshot_mismatch')
            if a == b and a != 'CANNOT_TELL':
                R.require(f.get('routing') == 'CONCORDANT_'+a and f.get('final_status') == 'CONCORDANT' and
                          f.get('final_answer') == a, 'adjudication_snapshot_mismatch')
                reference[uid] = a
            elif f.get('adjudication_status') == 'UNRESOLVED_ESCALATED':
                R.require(f.get('routing') == 'ROUTED' and f.get('final_status') == 'UNRESOLVED' and
                          f.get('final_answer') == '' and f.get('adjudication_basis') == 'NONE',
                          'adjudication_snapshot_mismatch')
                reference[uid] = 'UNRESOLVED'
            else:
                answer, basis = f.get('final_answer'), f.get('adjudication_basis')
                R.require(f.get('routing') == 'ROUTED' and f.get('final_status') == 'ADJUDICATED' and
                          f.get('adjudication_status') == 'DISCORDANT_RESOLVED' and answer in ('AGREE', 'DISAGREE') and
                          ((basis == 'REVIEWER_1' and answer == a) or (basis == 'REVIEWER_2' and answer == b) or
                           (basis == 'NEITHER' and answer not in (a, b))), 'adjudication_snapshot_mismatch')
                reference[uid] = answer
    return {'manifest': manifest, 'latest': latest, 'reference': reference, 'reviewers_finished': True,
            'adjudication_present': adjudication_digest is not None}
