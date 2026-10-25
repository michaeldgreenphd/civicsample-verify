"""Independent Python and TypeScript checks of database-written synthetic histories."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

import pytest
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_mu81_observations import bundle, manifest, replace_csv, write_manifest, P  # noqa: E402,F401


def sha(s):
    return hashlib.sha256(s.encode()).hexdigest()


def both_refuse(bundle):
    with pytest.raises(P.Refused):
        P.load_bundle(bundle, True, None)
    # Rehashing a damaged CSV or even supplying the edited manifest hash cannot bypass semantics.
    result = subprocess.run(['node', '--import', 'tsx', 'scripts/verify-mu7-bundle.ts', '--bundle', str(bundle),
                             '--expect-manifest-sha256', hashlib.sha256((bundle / 'manifest.json').read_bytes()).hexdigest()],
                            capture_output=True, text=True, check=False)
    assert result.returncode == 1, result.stdout + result.stderr
    assert json.loads(result.stdout)['registrationVerified'] is False


def test_full_history_preserves_microseconds_and_free_text(bundle):
    b = P.load_bundle(bundle, True, None)
    assert b['manifest']['bundle_format_version'] == '8.2'
    assert b['manifest']['snapshot']['n_rows'] == 202
    text = (bundle / 'judgment_history.csv').read_bytes().decode()
    assert '2026-10-25T01:02:03.123456Z' in text  # timestamp-looking note must not be truncated
    assert 'Intermediate fictional note|with a delimiter\nAnd a new line\rAnd CR' in text


@pytest.mark.parametrize('column,value', [
    ('note', 'Altered synthetic note'), ('reason_code', 'OTHER_SPECIFIED'),
    ('uncertain', 'false'), ('seconds_on_unit', '27'), ('diabetes_subtype', 'TYPE_2_NOT_STATED'),
    ('content_sha256', '0'*64), ('revision_number', '4'), ('reviewer_slot', '2'),
    ('reviewer_pseudo_id', 'different-synthetic-reviewer'), ('mode', 'PILOT'),
    ('submitted_at_utc', '2026-10-25T00:00:00.123456Z'),
    ('submitted_at_utc', '2026-02-30T00:00:00.123456Z'),
    ('assignment_id', '00000000-0000-4000-8000-000000000099'),
])
def test_intermediate_mutation_with_refreshed_file_hash_is_refused(bundle, column, value):
    def change(t):
        i = t.index[t.revision_number.eq('2')][0]
        t.loc[i, column] = value
    replace_csv(bundle, 'judgment_history.csv', change)
    both_refuse(bundle)


def test_missing_intermediate_revision_is_refused(bundle):
    replace_csv(bundle, 'judgment_history.csv', lambda t: t.drop(t.index[t.revision_number.eq('2')], inplace=True))
    both_refuse(bundle)


def test_rehashed_intermediate_answer_still_disagrees_with_locked_snapshot(bundle):
    changed = {}
    def change(t):
        i = t.index[t.revision_number.eq('2')][0]
        t.loc[i, 'note'] = 'Altered synthetic note with recomputed digest'
        r = t.loc[i]
        base = sha('|'.join(r[k] for k in ('assignment_id','revision_number','answer','reason_code','note','uncertain','seconds_on_unit')))
        t.loc[i, 'content_sha256'] = sha('mu81-judgment-1|' + base + '|' + r.diabetes_subtype)
        changed.update(unit=r.unit_id, slot=r.reviewer_slot, digest=t.loc[i, 'content_sha256'])
    replace_csv(bundle, 'judgment_history.csv', change)
    def obs(t):
        t.loc[t.unit_id.eq(changed['unit']) & t.reviewer_slot.eq(changed['slot']) & t.revision_number.eq('2'), 'content_sha256'] = changed['digest']
    replace_csv(bundle, 'subtype_observations.csv', obs)
    both_refuse(bundle)


def test_microsecond_change_cannot_hide_in_truncated_endpoint(bundle):
    def change(t):
        t.loc[0, 'submitted_at_utc'] = t.loc[0, 'submitted_at_utc'][:23] + ('999' if not t.loc[0, 'submitted_at_utc'].endswith('999Z') else '998') + 'Z'
    replace_csv(bundle, 'judgment_history.csv', change)
    both_refuse(bundle)


def test_endpoint_note_must_match_history(bundle):
    replace_csv(bundle, 'independent_judgments.csv', lambda t: t.loc.__setitem__((0, 'note_initial'), 'Unmatched synthetic note'))
    both_refuse(bundle)


def test_missing_history_contract_refused(bundle):
    m = manifest(bundle)
    del m['history_contract_version']
    write_manifest(bundle, m)
    both_refuse(bundle)


def test_legacy_81_remains_readable_without_snapshot_reconstruction(bundle):
    m = manifest(bundle)
    m['bundle_format_version'] = '8.1'
    del m['history_contract_version']
    del m['files']['judgment_history.csv']
    del m['row_counts']['judgment_history.csv']
    (bundle / 'judgment_history.csv').unlink()
    write_manifest(bundle, m)
    P.load_bundle(bundle, True, None)
    result = subprocess.run(['node','--import','tsx','scripts/verify-mu7-bundle.ts','--bundle',str(bundle)], capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr


def test_manifest_requires_independent_anchor_for_registration(bundle):
    original = hashlib.sha256((bundle / 'manifest.json').read_bytes()).hexdigest()
    P.load_bundle(bundle, True, None, original)
    m = manifest(bundle)
    m['app_git_sha'] = 'e'*40
    write_manifest(bundle,m)
    result = subprocess.run(['node','--import','tsx','scripts/verify-mu7-bundle.ts','--bundle',str(bundle),
                             '--expect-manifest-sha256',original],capture_output=True,text=True)
    assert result.returncode == 1
    assert 'registered manifest hash' in result.stdout

    with pytest.raises(P.Refused, match='registered manifest hash'):
        P.load_bundle(bundle, True, None, original)


def test_delimiter_shift_cannot_reinterpret_a_hashed_note_as_a_reason(bundle):
    # The legacy digest joins fields with '|'; enforce its fixed-code fields to avoid ambiguity.
    def change(t):
        i = t.index[t.revision_number.eq('2')][0]
        first, rest = t.loc[i, 'note'].split('|', 1)
        t.loc[i, 'reason_code'] += '|' + first
        t.loc[i, 'note'] = rest
    replace_csv(bundle, 'judgment_history.csv', change)
    both_refuse(bundle)
