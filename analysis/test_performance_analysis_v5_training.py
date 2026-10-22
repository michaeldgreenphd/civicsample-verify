"""SYNTHETIC ENGINEERING ONLY. Proposed analysis; no clinical study results.

analysis/test_performance_analysis_v5_training.py : v5.1 tests (migration 0005) of performance_analysis_v5,
on SYNTHETIC bundles only. performance_analysis_v5.py itself is unchanged by v5.1.

What these tests pin down:
  * worked training examples (mode TRAINING, prefix EX5-) can never enter an analysis bundle;
  * 0005 leaves the three export views unchanged (column contract read from view_columns_v5_1.json, written by
    tests_prebuild/pglite_rls_v5/rls_tests_v5_1.mjs);
  * the manifest field db_schema_version names the version of the export contract ("5.0.0"). 0005 changes no
    export view, so a bundle from a v5.1 database still declares "5.0.0"; a bundle that declares "5.1.0" is
    refused, so a mistaken manifest stops the analysis instead of passing silently.

Run from the repository root:  python -m pytest -q analysis/test_performance_analysis_v5_training.py
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

try:
    from analysis import performance_analysis_v5 as pa5
    from analysis.fixtures import make_synthetic_v5_bundle as fx
    from analysis.test_performance_analysis_v5 import _df, _rewrite
except ImportError:  # run from inside analysis/
    import performance_analysis_v5 as pa5  # type: ignore
    from fixtures import make_synthetic_v5_bundle as fx  # type: ignore
    from test_performance_analysis_v5 import _df, _rewrite  # type: ignore

HERE = Path(__file__).resolve().parent


@pytest.fixture()
def bundle(tmp_path):
    return fx.write(str(tmp_path / "b"), overwrite=True)


def test_refuses_a_training_bundle(bundle):
    _rewrite(bundle, "independent_judgments", manifest_update={"mode": "TRAINING"})
    with pytest.raises(pa5.ExportError, match="mode must be FORMAL"):
        pa5.run(str(bundle), allow_synthetic=True)


def test_refuses_training_rows_in_a_formal_bundle(bundle):
    J = _df(bundle, "independent_judgments")
    J.loc[J.index[:19], "mode"] = "TRAINING"
    _rewrite(bundle, "independent_judgments", J)
    with pytest.raises(pa5.ExportError, match="every row must carry mode FORMAL"):
        pa5.run(str(bundle), allow_synthetic=True)


def test_refuses_a_training_case_id_in_a_formal_bundle(bundle):
    J = _df(bundle, "independent_judgments")
    J.loc[J.index[:19], "case_id"] = "EX5-01"
    _rewrite(bundle, "independent_judgments", J)
    with pytest.raises(pa5.ExportError, match="not of the form TLV5-nnn"):
        pa5.run(str(bundle), allow_synthetic=True)


def test_manifest_names_the_export_contract_version(bundle):
    assert pa5.DB_SCHEMA_VERSION_V5 == "5.0.0"
    _rewrite(bundle, "independent_judgments", manifest_update={"db_schema_version": "5.1.0"})
    with pytest.raises(pa5.ExportError, match="db_schema_version"):
        pa5.run(str(bundle), allow_synthetic=True)


def test_export_views_unchanged_by_0005():
    """The three export views after 0005 have exactly the columns the analysis expects."""
    f = HERE / "fixtures" / "view_columns_v5_1.json"
    if not f.exists():
        pytest.skip("view_columns_v5_1.json not found (column contract fixture missing)")
    cols = json.loads(f.read_text())
    strip = lambda xs: [x.split(":")[0] for x in xs]  # noqa: E731
    assert strip(cols["v_tlv5_independent_judgments"]) == pa5.JUDGMENT_COLUMNS_V5
    assert strip(cols["v_tlv5_adjudicated_reference"]) == pa5.REFERENCE_COLUMNS_V5
    assert strip(cols["v_tlv5_frozen_labels"]) == pa5.LABEL_COLUMNS_V5
    v5 = HERE / "fixtures" / "view_columns_v5.json"
    if v5.exists():
        old = json.loads(v5.read_text())
        for view in ("v_tlv5_independent_judgments", "v_tlv5_adjudicated_reference", "v_tlv5_frozen_labels"):
            assert cols[view] == old[view], f"{view} changed between 0004 and 0005"
