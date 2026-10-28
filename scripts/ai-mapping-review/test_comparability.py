"""Fictional snapshots only; no study material or network."""
import copy
import json
import tempfile
import unittest
from pathlib import Path

import runner as R
import check_live_comparability as C
from test_runner import fixture


def live_fixture(ai):
    units = copy.deepcopy(ai['units'])
    for u in units:
        # Fictional exported storage digest; production captures this from the DB.
        u['stored_packet_sha256'] = R.sha(R.encode(u['packet']))
    return {'format': C.FORMAT, 'captured_at': '2026-01-01T00:00:00Z', 'app_commit': 'd' * 40,
            'renderer_revision_verified': True,
            'freeze': {'unit_list_sha256': ai['source']['sample_sha256'],
                       'import_sha256': ai['source']['prepared_import_sha256']},
            'guide': copy.deepcopy(ai['guide']), 'units': units}


class ComparabilityTests(unittest.TestCase):
    def setUp(self):
        self.ai = fixture()
        self.ai['source']['sample_sha256'] = R.sha('\n'.join(sorted(u['unit_id'] for u in self.ai['units'])).encode())
        self.live = live_fixture(self.ai)

    def test_identity_and_reordered_units(self):
        self.live['units'].reverse()
        summary, rows = C.compare(self.ai, self.live)
        self.assertTrue(summary['unit_list_sha256_equal'])
        self.assertTrue(summary['import_sha256_equal'])
        self.assertEqual(sum(summary['displayed_text_differences'].values()), 0)
        self.assertEqual(summary['packet_differences'], 0)
        self.assertTrue(all(r['packet_identical'] and r['displayed_text_identical'] for r in rows))
        self.assertNotIn('SYN-', json.dumps(summary))

    def test_counts_are_per_unit_and_field_not_text(self):
        self.live['units'][0]['display']['title'] = 'Different fictional title'
        self.live['units'][0]['display']['question'] = 'Different fictional question?'
        self.live['units'][1]['answer_options'][0]['label'] = 'Fictional option'
        self.live['units'][2]['packet']['trial']['brief_title'] = 'Different fictional packet'
        summary, rows = C.compare(self.ai, self.live)
        for key in ('title', 'question', 'response_options'):
            self.assertEqual(summary['displayed_text_differences'][key], 1)
        self.assertEqual(summary['packet_differences'], 1)
        self.assertEqual(sum(not r['displayed_text_identical'] for r in rows), 2)
        self.assertNotIn('fictional', json.dumps(summary))

    def test_guide_change_is_not_silently_rewritten(self):
        self.live['guide']['text'] = 'A different fictional completion policy.'
        self.live['guide']['sha256'] = R.sha(self.live['guide']['text'].encode())
        summary, _ = C.compare(self.ai, self.live)
        self.assertNotEqual(summary['guide_ai_sha256'], summary['guide_live_sha256'])
        self.assertEqual(sum(summary['displayed_text_differences'].values()), 0)

    def test_option_order_is_an_observed_difference(self):
        self.live['units'][0]['answer_options'].reverse()
        before = copy.deepcopy(self.live)
        summary, _ = C.compare(self.ai, self.live)
        self.assertEqual(summary['displayed_text_differences']['response_options'], 1)
        self.assertEqual(before, self.live)

    def test_matching_stale_hashes_do_not_certify_unit_inventory(self):
        self.ai['source']['sample_sha256'] = 'f' * 64
        self.live['freeze']['unit_list_sha256'] = 'f' * 64
        summary, _ = C.compare(self.ai, self.live)
        self.assertFalse(summary['unit_list_sha256_equal'])

    def test_freeze_mismatch_reported_even_with_same_unit_ids(self):
        self.live['freeze']['unit_list_sha256'] = 'e' * 64
        self.live['freeze']['import_sha256'] = 'f' * 64
        summary, _ = C.compare(self.ai, self.live)
        self.assertFalse(summary['unit_list_sha256_equal'])
        self.assertFalse(summary['import_sha256_equal'])

    def test_missing_extra_duplicate_units_and_answer_fields_refused(self):
        for edit in (
            lambda x: x['units'].pop(),
            lambda x: x['units'].append(copy.deepcopy(x['units'][0])),
            lambda x: x['units'][1].update(unit_id=x['units'][0]['unit_id']),
            lambda x: x.update(reviewer_answers=[]),
            lambda x: x['units'][0].update(answer='AGREE'),
            lambda x: x.update(captured_at='2026-01-01'),
            lambda x: x.update(renderer_revision_verified=False),
            lambda x: x['guide'].update(sha256='f' * 64),
        ):
            live = copy.deepcopy(self.live)
            edit(live)
            with self.assertRaises(R.Refused):
                C.compare(self.ai, live)

    def test_equal_count_different_sample_is_not_paired_by_position(self):
        u = self.live['units'][0]
        u['unit_id'] = u['packet']['unit']['unit_id'] = 'SYN-OTHER'
        with self.assertRaisesRegex(R.Refused, 'sample_units_differ'):
            C.compare(self.ai, self.live)

    def test_hash_pin_and_public_checkout_guards(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            path = root / 'input.json'
            path.write_bytes(b'{}')
            self.assertEqual(C.read_private(str(path), R.sha(b'{}')), b'{}')
            with self.assertRaises(R.Refused):
                C.read_private(str(path), '0' * 64)
            (root / '.git').mkdir()
            with self.assertRaisesRegex(R.Refused, 'private_input_required'):
                C.read_private(str(path), R.sha(b'{}'))


if __name__ == '__main__':
    unittest.main()
