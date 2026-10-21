"""SYNTHETIC ENGINEERING ONLY: regression tests for the public harness boundary."""
import json
import math

import pytest

from analysis import agreement_metrics as am
from analysis import performance_analysis_v3 as pa3
from analysis import performance_analysis_v4 as pa4
from analysis.fixtures import make_synthetic_v4_bundle as fx


@pytest.fixture
def bundle(tmp_path):
    fx.write(tmp_path)
    return pa4.load_bundle(str(tmp_path / fx.MANIFEST_NAME))


def test_real_data_disabled_even_with_override(bundle):
    data, manifest = bundle
    manifest['is_synthetic_fixture'] = False
    with pytest.raises(pa4.ExportError, match='real-data analysis is disabled'):
        pa4.validate_bundle(data, manifest, allow_synthetic=True)


def test_pilot_never_enters_metrics(bundle):
    data, manifest = bundle
    for frame in data.values():
        frame['case_id'] = frame.case_id.str.replace('HO4-TESTFX-', 'SYN-', regex=False)
        frame['record_category'] = 'SYNTHETIC_PILOT'
    with pytest.raises(pa4.ExportError, match='pilot'):
        pa4.validate_bundle(data, manifest, allow_synthetic=True)


def test_direct_result_generation_cannot_bypass_synthetic_gate(bundle):
    data, manifest = bundle
    merged, passed = pa4.validate_bundle(data, manifest, allow_synthetic=True)
    manifest['is_synthetic_fixture'] = False
    with pytest.raises(pa4.ExportError, match='real-data and pilot analysis disabled'):
        pa4.build_results(merged, manifest, passed)
    with pytest.raises(pa3.ExportError, match='Legacy direct analysis disabled'):
        pa3.build_results(merged, manifest)


def test_missing_reference_distinct_from_explicit_indeterminate():
    for rule in pa3.DENOMINATOR_RULES:
        mapped, counts = pa3.reference_binary([None, 'INSUFFICIENT_INFORMATION', 'CONTEXT_DEPENDENT', 'INCLUDE', 'EXCLUDE'], rule)
        assert mapped[0] is None
        assert counts['UNRESOLVED_OR_MISSING'] == 1
        assert counts['INSUFFICIENT_INFORMATION'] == 1
        assert counts['CONTEXT_DEPENDENT'] == 1
        if rule == 'R0_primary':
            assert mapped[:3] == [None, None, None]
        else:
            assert mapped[1] is not None and mapped[2] is not None


def test_unidentified_design_variance_never_gets_ci():
    num, den, weights = [1] + [0] * 5 + [1] * 5, [1] * 11, [4] + [2] * 10
    strata, sizes = ['single'] + ['other'] * 10, {'single': 4, 'other': 20}
    out = am.weighted_ratio(num, den, weights, strata, sizes)
    assert out['estimate'] == pytest.approx(7 / 12)
    assert out['ci_estimable'] is False and math.isnan(out['ci_low'])
    capped = pa3.weighted_ratio_v3(num, den, weights, strata, sizes)
    assert capped['estimate'] == pytest.approx(7 / 12) and math.isnan(capped['ci_low'])
    paired = pa3.weighted_paired_difference(num, [0] + [1] * 5 + [0] * 5, den, weights, strata, sizes)
    assert paired['estimate'] == pytest.approx(1 / 6) and math.isnan(paired['ci_high'])
    assert 'singleton' in paired['not_estimable_reason']


def test_zero_denominator_is_null_after_serialization():
    result = am.diagnostic_accuracy(['INCLUDE'], ['INCLUDE'], 'INCLUDE', 'EXCLUDE')
    normalized = pa3._jsonable(result)
    assert normalized['specificity']['estimate'] is None
    assert normalized['specificity']['ci_low'] is None


def test_manifest_paths_cannot_escape_bundle(tmp_path):
    manifest = fx.write(tmp_path)
    manifest['files'][0]['name'] = '../outside.csv'
    path = tmp_path / fx.MANIFEST_NAME
    path.write_text(json.dumps(manifest))
    with pytest.raises(pa4.ExportError, match='basenames'):
        pa4.load_bundle(str(path))


@pytest.mark.parametrize('value', ['0', 'nan', '-1', '1.5'])
def test_variance_stratum_size_rejected(bundle, value):
    data, manifest = bundle
    data['frozen_predictions'].loc[0, 'variance_stratum_size'] = value
    with pytest.raises(pa4.ExportError, match='variance stratum sizes'):
        pa4.validate_bundle(data, manifest, allow_synthetic=True)


def test_manifest_boolean_is_not_truthy_string(bundle):
    data, manifest = bundle
    manifest['reference_locked'] = 'false'
    with pytest.raises(pa4.ExportError, match='not locked'):
        pa4.validate_bundle(data, manifest, allow_synthetic=True)


def test_fractional_revision_count_rejected(bundle):
    data, manifest = bundle
    data['independent_judgments'].loc[0, 'n_revisions_preclose'] = '1.5'
    with pytest.raises(pa4.ExportError, match='non-negative integer'):
        pa4.validate_bundle(data, manifest, allow_synthetic=True)
