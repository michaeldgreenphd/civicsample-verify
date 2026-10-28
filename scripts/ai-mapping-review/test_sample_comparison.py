"""End-to-end offline checks with a fictional completion-aware app export."""
import copy
from collections import Counter
import csv
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import runner as R
import check_live_comparability as C
import compare_sample as S
import completed_runs as B
import locked_review as H
from test_runner import fixture, FakeProvider
from test_comparability import live_fixture
from test_label_pilot import fixture as pilot_fixture, Provider as PilotProvider
import label_pilot as P


def encode_csv(rows):
    s = io.StringIO(newline='')
    writer = csv.DictWriter(s, fieldnames=list(rows[0]), lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    return s.getvalue().encode()


def plan_fixture():
    return {'format': S.PLAN_FORMAT, 'status': 'APPROVED', 'approved_at': '2025-12-31T00:00:00Z',
        'approval_ref': 'SYNTHETIC-ANALYSIS-APPROVAL', 'protocol_sha256': 'a'*64,
        'unresolved_reference': 'REPORT_SEPARATELY_EXCLUDE_FROM_AGREEMENT',
        'comparability_handling': 'REPORT_PER_UNIT_COVARIATES',
        'screening_model_decision': {'status': 'FIXED_BEFORE_HUMAN_EXPORT',
                                   'recorded_at': '2025-12-31T00:00:00Z', 'model': R.MODELS[1]}}


def make_export(root):
    ai = fixture()
    for i, u in enumerate(ai['units']):
        family = 'AREA' if i < 56 else 'ROW' if i < 96 else 'SG'
        u['packet']['unit'].update(family=family, category='CARDIOVASCULAR' if family == 'AREA' else 'DIAB',
            unit_role='SUBGROUP' if family == 'SG' else 'PRIMARY', assignment_code='IN_AREA')
        u['subtype_required'] = i == 60
        if i == 60:
            u['packet']['unit']['assignment_code'] = 'D4A_KEEP_UNRESOLVED_PARENT_ONLY'
    ai['source']['sample_sha256'] = H.hash_text('\n'.join(sorted(u['unit_id'] for u in ai['units'])))
    ai_raw = R.encode(ai)
    ledger = R.new_state(R.sha(ai_raw), R.MAX_CAP_MICRO_USD, 'SYNTHETIC-PAID-APPROVAL')
    R.run(ai, R.sha(ai_raw), ledger, R.MAX_CAP_MICRO_USD, 'SYNTHETIC-PAID-APPROVAL', FakeProvider(), lambda _: None)
    live = live_fixture(ai)
    live['guide']['text'] = 'Fictional completion-aware guide. Not a clinical policy.'
    live['guide']['sha256'] = H.hash_text(live['guide']['text'])
    live['guide']['profile_id'] = 'SYNTHETIC-NEW-GUIDE'
    protocol = {'mode': 'FORMAL', 'protocol_id': 'mu84-finish-and-adjudicate-1',
        'guide_sha256': live['guide']['sha256'], 'base_profile_sha256': 'b'*64}
    protocol['binding_sha256'] = H.hash_text('|'.join(['mu84-completion-binding-1', 'FORMAL',
        protocol['protocol_id'], protocol['base_profile_sha256'], protocol['guide_sha256']]))
    units, history, judgments, observations, finals, flags = [], [], [], [], [], []
    answers = [('AGREE', 'DISAGREE'), ('CANNOT_TELL', 'CANNOT_TELL'), ('AGREE', 'AGREE'),
               ('CANNOT_TELL', 'DISAGREE'), ('DISAGREE', 'DISAGREE')]
    for i, u in enumerate(ai['units']):
        uid = u['unit_id']
        unit = u['packet']['unit']
        units.append({k: unit[k] for k in ('unit_id', 'mode', 'family', 'category', 'unit_role',
                                           'mapping_code', 'assignment_code', 'assignment_status')})
        units[-1]['packet_sha256'] = live['units'][i]['stored_packet_sha256']
        pair = answers[i % 5]
        for slot, a in zip(('1', '2'), pair):
            r = {'unit_id': uid, 'mode': 'FORMAL', 'assignment_id': f'00000000-0000-4000-8000-{i*2+int(slot):012d}',
                'reviewer_slot': slot, 'reviewer_pseudo_id': 'R-SYN'+slot, 'revision_number': '1',
                'answer': a, 'reason_code': 'OTHER_SPECIFIED' if a == 'DISAGREE' else '',
                'note': 'Fictional explanation.', 'uncertain': 'false', 'seconds_on_unit': '20',
                'diabetes_subtype': 'TYPE_2_NOT_STATED' if u['subtype_required'] else '',
                'submitted_at_utc': '2026-01-01T00:00:00.000000Z'}
            base = H.hash_text('|'.join(r[k] for k in ('assignment_id', 'revision_number', 'answer',
                'reason_code', 'note', 'uncertain', 'seconds_on_unit')))
            r['content_sha256'] = H.hash_text('mu81-judgment-1|'+base+'|'+r['diabetes_subtype'])
            history.append(r)
            observations.append({k: r[k] for k in ('unit_id', 'mode', 'reviewer_slot', 'revision_number',
                                                  'answer', 'diabetes_subtype', 'content_sha256')})
            j = {k: r[k] for k in ('unit_id', 'mode', 'reviewer_slot', 'reviewer_pseudo_id')}
            j.update(judgment_status='ANSWERED', n_revisions='0', first_submitted_at='2026-01-01T00:00:00.000Z',
                     last_submitted_at='2026-01-01T00:00:00.000Z')
            for suffix in ('initial', 'effective'):
                j.update({f'{k}_{suffix}': r[source] for k, source in
                          (('answer','answer'), ('reason','reason_code'), ('note','note'), ('uncertain','uncertain'))})
            judgments.append(j)
        a, b = pair
        f = {'unit_id': uid, 'mode': 'FORMAL', 'answer_effective_slot1': a, 'answer_effective_slot2': b,
             'routing': 'ROUTED', 'final_answer': '', 'final_status': 'UNRESOLVED',
             'adjudication_status': 'UNRESOLVED_ESCALATED', 'adjudication_basis': 'NONE'}
        f.update({k: unit[k] for k in ('family', 'category', 'unit_role', 'mapping_code', 'assignment_code', 'assignment_status')})
        if a == b and a != 'CANNOT_TELL':
            f.update(routing='CONCORDANT_'+a, final_answer=a, final_status='CONCORDANT',
                     adjudication_status='', adjudication_basis='')
        elif i % 5 != 0:
            f.update(final_answer='AGREE' if a == b else b, final_status='ADJUDICATED',
                     adjudication_status='DISCORDANT_RESOLVED', adjudication_basis='NEITHER' if a == b else 'REVIEWER_2')
        finals.append(f)
        flags.append({'unit_id': uid, 'mode': 'FORMAL', 'both_final_cannot_tell': str(a == b == 'CANNOT_TELL').lower()})
    receipts = []
    for slot in ('1', '2'):
        chosen = sorted((r for r in history if r['reviewer_slot'] == slot), key=lambda r: r['unit_id'])
        txt = '\n'.join('|'.join(r[k] for k in ('unit_id', 'reviewer_slot', 'assignment_id',
                                               'revision_number', 'content_sha256')) for r in chosen)
        receipt = {'mode': 'FORMAL', 'reviewer_pseudo_id': 'R-SYN'+slot, 'reviewer_slot': slot,
            'answer_count': '100', 'answers_text': txt, 'answers_sha256': H.hash_text(txt),
            'protocol_binding_sha256': protocol['binding_sha256'], 'finished_at': '2026-01-01T01:00:00.000Z'}
        receipt['receipt_sha256'] = H.hash_text('|'.join(['mu84-completion-receipt-1', 'FORMAL',
            receipt['reviewer_pseudo_id'], protocol['binding_sha256'], receipt['answers_sha256']]))
        receipts.append(receipt)
    body = '\n'.join('|'.join(r[k] for k in ('unit_id', 'reviewer_slot', 'reviewer_pseudo_id', 'revision_number',
        'answer', 'reason_code', 'note', 'uncertain', 'content_sha256', 'submitted_at_utc'))
        for r in sorted(history, key=lambda r: (r['unit_id'], int(r['reviewer_slot']), int(r['revision_number']))))
    data = {'units.csv': units, 'independent_judgments.csv': judgments, 'judgment_history.csv': history,
        'subtype_observations.csv': observations, 'final_reference.csv': finals, 'final_answer_flags.csv': flags,
        'review_completions.csv': receipts}
    files = {name: encode_csv(rows) for name, rows in data.items()}
    files.update({'completion_protocol.json': R.encode(protocol), 'reviewer_guide_current.md': live['guide']['text'].encode()})
    manifest = {'bundle_format_version': '8.4', 'mode': 'FORMAL', 'status': 'FORMAL',
        'reference_locked_at': '2026-01-02T00:00:00.000Z', 'n_units_locked': 100,
        'history_contract_version': 'mu81-history-1', 'reviewer_profile': {'binding_sha256': 'b'*64},
        'freeze': {'unit_list_sha256': ai['source']['sample_sha256'], 'completion_protocol_sha256': protocol['binding_sha256']},
        'snapshot': {'n_rows': len(history), 'content_sha256': H.hash_text(body), 'taken_at': '2026-01-01T02:00:00Z'},
        'files': {name: R.sha(raw) for name, raw in files.items()},
        'row_counts': {name: len(rows) for name, rows in data.items()}}
    for name, raw in files.items():
        (root/name).write_bytes(raw)
    (root/'manifest.json').write_bytes(R.encode(manifest))
    return ai, ledger, live, manifest


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.ai, self.ledger, self.live, self.manifest = make_export(self.root)

    def load(self, r2=True):
        return H.load(self.root, R.sha((self.root/'manifest.json').read_bytes()), self.live,
                      adjudication_digest=self.manifest['files']['final_reference.csv'] if r2 else None)

    def rewrite(self, name, rows):
        raw = encode_csv(rows)
        (self.root/name).write_bytes(raw)
        self.manifest['files'][name] = R.sha(raw)
        self.manifest['row_counts'][name] = len(rows)
        (self.root/'manifest.json').write_bytes(R.encode(self.manifest))

    def test_locked_export_roundtrip_and_unresolved_not_cannot_tell(self):
        review = self.load()
        self.assertEqual(len(review['latest']), 200)
        self.assertEqual(Counter(review['reference'].values()), {'UNRESOLVED': 20, 'AGREE': 40, 'DISAGREE': 40})
        report, trace = S.analyze(self.ai, self.ledger, review, C.compare(self.ai, self.live), 'both', {})
        rows = list(csv.DictReader(io.StringIO(trace)))
        self.assertEqual(len(rows), 1505)  # 3 models × (3 refs + pair pattern) + 3 consistency pairs; 5 subtype roles.
        self.assertEqual(sum(r['reference_answer'] == 'UNRESOLVED' for r in rows), 60)
        self.assertNotIn('Fictional explanation.', report+trace)
        self.assertNotIn('R-SYN1', report+trace)
        self.assertIn('Consistency only', report)
        self.assertIn('## SG — 4 units', report)
        self.assertIn('Unresolved references, kept outside', report)
        self.assertTrue(all(r['displayed_text_identical'] == 'true' and r['packet_identical'] == 'true' for r in rows))

    def test_no_receipts_refuses_before_opening_any_answer_file(self):
        del self.manifest['files']['review_completions.csv']
        (self.root/'manifest.json').write_bytes(R.encode(self.manifest))
        opened = []
        original = H.read_private
        def track(path, sha):
            opened.append(Path(path).name)
            return original(path, sha)
        with patch.object(H, 'read_private', track), self.assertRaisesRegex(R.Refused, 'completion_receipts_required'):
            self.load()
        self.assertEqual(opened, ['manifest.json'])

    def test_one_receipt_or_duplicate_slot_refused_before_answers(self):
        rows = H.csv_rows((self.root/'review_completions.csv').read_bytes())
        self.rewrite('review_completions.csv', [rows[0], rows[0]])
        with self.assertRaisesRegex(R.Refused, 'completion_receipts_required'):
            self.load()

    def test_receipt_content_hash_tamper_is_not_just_presence_check(self):
        rows = H.csv_rows((self.root/'review_completions.csv').read_bytes())
        rows[0]['answers_sha256'] = 'c'*64
        self.rewrite('review_completions.csv', rows)
        with self.assertRaisesRegex(R.Refused, 'completion_receipt_mismatch'):
            self.load()

    def test_file_checksum_and_judgment_snapshot_tamper_refused(self):
        (self.root/'judgment_history.csv').write_bytes(b'changed')
        with self.assertRaisesRegex(R.Refused, 'input_digest_mismatch'):
            self.load()

    def test_history_and_effective_answer_divergence_refused(self):
        rows = H.csv_rows((self.root/'independent_judgments.csv').read_bytes())
        rows[0]['answer_effective'] = 'DISAGREE'
        self.rewrite('independent_judgments.csv', rows)
        with self.assertRaisesRegex(R.Refused, 'judgment_history_mismatch'):
            self.load()

    def test_r1_does_not_open_adjudication_file_and_r2_requires_snapshot(self):
        (self.root/'final_reference.csv').unlink()
        self.assertFalse(self.load(False)['adjudication_present'])
        with self.assertRaises(R.Refused):
            self.load(True)
        self.manifest['reference_locked_at'] = ''
        (self.root/'manifest.json').write_bytes(R.encode(self.manifest))
        with self.assertRaisesRegex(R.Refused, 'adjudication_snapshot_required'):
            self.load(True)

    def test_both_cannot_tell_must_route_under_r5(self):
        rows = H.csv_rows((self.root/'final_reference.csv').read_bytes())
        rows[1].update(routing='BOTH_CANNOT_TELL', final_answer='CANNOT_TELL', final_status='CANNOT_TELL_BY_RULE')
        self.rewrite('final_reference.csv', rows)
        with self.assertRaisesRegex(R.Refused, 'adjudication_snapshot_mismatch'):
            self.load()

    def test_prespecification_and_close_chronology_are_checked(self):
        with self.assertRaisesRegex(R.Refused, 'analysis_approval_after_review_close'):
            H.load(self.root, R.sha((self.root/'manifest.json').read_bytes()), self.live,
                   approved_at='2026-01-03T00:00:00Z')
        self.manifest['snapshot']['taken_at'] = '2026-01-01T00:30:00Z'
        (self.root/'manifest.json').write_bytes(R.encode(self.manifest))
        with self.assertRaisesRegex(R.Refused, 'review_close_precedes_completion'):
            self.load()

    def test_wrong_sample_and_duplicate_judgment_refused(self):
        rows = H.csv_rows((self.root/'independent_judgments.csv').read_bytes())
        rows[1] = rows[0]
        self.rewrite('independent_judgments.csv', rows)
        with self.assertRaisesRegex(R.Refused, 'review_judgments_incomplete'):
            self.load()

    def test_export_packet_binding_and_assignment_identity(self):
        rows = H.csv_rows((self.root/'units.csv').read_bytes())
        rows[0]['packet_sha256'] = 'e'*64
        self.rewrite('units.csv', rows)
        with self.assertRaisesRegex(R.Refused, 'review_packet_mismatch'):
            self.load()
        live = copy.deepcopy(self.live)
        live['units'][0]['packet']['unit']['category'] = 'IMMUNE'
        with self.assertRaisesRegex(R.Refused, 'assignment_task_changed'):
            S.validate_same_assignments(self.ai, live)

    def test_changed_display_is_covariate_not_rerun(self):
        self.live['units'][0]['display']['question'] = 'Another fictional question?'
        report, trace = S.analyze(self.ai, self.ledger, self.load(), C.compare(self.ai, self.live), 'R1', {})
        rows = list(csv.DictReader(io.StringIO(trace)))
        changed = [r for r in rows if r['displayed_text_identical'] == 'false']
        self.assertTrue(changed)
        self.assertTrue(all(r['changed_fields'] == 'question' for r in changed))
        self.assertEqual(len({r['unit_id'] for r in changed}), 1)

    def test_statistics_denominators_missing_unresolved_and_small_family(self):
        pairs = [('AGREE','AGREE')]*8 + [('DISAGREE','DISAGREE')]*8 + [('AGREE','DISAGREE')]*4
        s = S.statistics(pairs + [('MISSING','AGREE'), ('DISAGREE','UNRESOLVED')], 22)
        self.assertEqual((s['paired_n'], s['equal'], s['missing'], s['unresolved']), (20, 16, 1, 1))
        self.assertAlmostEqual(s['agreement'], .8)
        self.assertAlmostEqual(s['kappa'], .6153846153846154)
        self.assertAlmostEqual(s['wilson'][0], .5839825677)
        self.assertAlmostEqual(s['wilson'][1], .9193423374)
        self.assertIsNone(S.statistics(pairs[:4], 4)['agreement'])
        self.assertIsNone(S.statistics([('AGREE','AGREE')]*20, 20)['kappa'])
        self.assertIsNone(S.statistics([('AGREE','UNRESOLVED')]*20, 20)['agreement'])

    def test_plan_requires_approval_and_model_selection_before_export(self):
        plan = plan_fixture()
        self.assertEqual(S.validate_plan(R.encode(plan)), plan)
        plan['status'] = 'PROPOSED'
        with self.assertRaisesRegex(R.Refused, 'analysis_approval_required'):
            S.validate_plan(R.encode(plan))
        plan['status'] = 'APPROVED'
        plan['screening_model_decision']['status'] = 'PENDING'
        with self.assertRaisesRegex(R.Refused, 'screening_choice_required_before_human_export'):
            S.validate_plan(R.encode(plan))

    def test_cli_outputs_only_fixed_counts_and_hash_and_preserves_inputs(self):
        names = {'ai': R.encode(self.ai), 'ledger': R.encode(self.ledger), 'live': R.encode(self.live), 'plan': R.encode(plan_fixture())}
        for name, raw in names.items():
            (self.root/(name+'.json')).write_bytes(raw)
        output = self.root/'comparison'
        output.mkdir()
        cmd = [sys.executable, str(Path(S.__file__)), '--review-bundle', str(self.root),
               '--manifest-sha256', R.sha((self.root/'manifest.json').read_bytes()),
               '--adjudication-sha256', self.manifest['files']['final_reference.csv'], '--private-output', str(output)]
        for name, flag, pin in (('ai','ai-input','ai-sha256'), ('ledger','ledger','ledger-sha256'),
                               ('live','live-snapshot','live-sha256'), ('plan','analysis-plan','plan-sha256')):
            cmd += ['--'+flag, str(self.root/(name+'.json')), '--'+pin, R.sha(names[name])]
        result = subprocess.run(cmd, capture_output=True, text=True, env={**os.environ, 'PYTHONDONTWRITEBYTECODE':'1'})
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        public = json.loads(result.stdout)
        self.assertEqual(set(public), {'units','models','families','reviewers_finished','adjudication_present','report_sha256'})
        reports = list(output.glob('*/SAMPLE_COMPARISON_REPORT_*.md'))
        self.assertEqual(len(reports), 1)
        self.assertEqual(R.sha(reports[0].read_bytes()), public['report_sha256'])
        self.assertEqual(reports[0].stat().st_mode & 0o777, 0o600)
        for name, raw in names.items():
            self.assertEqual((self.root/(name+'.json')).read_bytes(), raw)
        self.assertNotIn('SYN-', result.stdout)


class CompletedLedgerTests(unittest.TestCase):
    def test_validates_prior_ledgers_without_generation_or_mutation(self):
        b, baseline_raw = pilot_fixture()
        digest = R.sha(R.encode(b))
        cost = P.verify_baseline(b, baseline_raw)
        state = P.new_state(digest, cost, P.PILOT_MAX, 'SYNTHETIC-PILOT-APPROVAL')
        P.run(b, digest, state, cost, P.PILOT_MAX, state['approval_ref'], PilotProvider(), lambda _: None)
        raw = R.encode(state)
        with patch.object(R.Provider, 'message', side_effect=AssertionError('No provider call')):
            _, _, summary = B.verify_prior(baseline_raw, R.sha(baseline_raw), R.encode(b), digest, raw, R.sha(raw))
        self.assertEqual(summary['combined_accounted_micro_usd'], cost + P.pilot_cost(state))
        self.assertEqual(summary['remaining_micro_usd'], R.MAX_CAP_MICRO_USD-cost-P.pilot_cost(state))
        self.assertEqual(raw, R.encode(state))
        state['records'][0]['charged_micro_usd'] = 0
        tampered = R.encode(state)
        with self.assertRaises(R.Refused):
            B.verify_prior(baseline_raw, R.sha(baseline_raw), R.encode(b), digest, tampered, R.sha(tampered))


if __name__ == '__main__':
    unittest.main()
