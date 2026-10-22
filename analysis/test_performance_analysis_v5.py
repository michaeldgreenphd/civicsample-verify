"""SYNTHETIC ENGINEERING ONLY. Proposed analysis; no clinical study results.

analysis/test_performance_analysis_v5.py : tests of performance_analysis_v5 on SYNTHETIC bundles only.

Run from the repository root:  python -m pytest -q analysis/test_performance_analysis_v5.py
Nothing here reads study data. Every bundle is written by fixtures/make_synthetic_v5_bundle.py into a
temporary folder.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

try:
    from analysis import performance_analysis_v5 as pa5
    from analysis import performance_analysis_v3 as pa3
    from analysis.fixtures import make_synthetic_v5_bundle as fx
except ImportError:  # run from inside analysis/
    import performance_analysis_v5 as pa5  # type: ignore
    import performance_analysis_v3 as pa3  # type: ignore
    from fixtures import make_synthetic_v5_bundle as fx  # type: ignore

HERE = Path(__file__).resolve().parent


@pytest.fixture()
def bundle(tmp_path):
    return fx.write(str(tmp_path / "b"), overwrite=True)


def _load(mp):
    data, manifest = pa5.load_bundle(str(mp))
    return data, manifest


def _rewrite(mp: Path, role: str, df: pd.DataFrame = None, manifest_update: dict = None) -> None:
    """Rewrite one file (and its manifest hash and row count), as an app re-export would."""
    m = json.loads(mp.read_text())
    if df is not None:
        f = next(x for x in m["files"] if x["role"] == role)
        p = mp.parent / f["name"]
        df.to_csv(p, index=False, lineterminator="\n")
        f["sha256"] = hashlib.sha256(p.read_bytes()).hexdigest()
        f["rows"] = int(len(df))
    if manifest_update:
        m.update(manifest_update)
    mp.write_text(json.dumps(m, indent=1))


def _df(mp: Path, role: str) -> pd.DataFrame:
    m = json.loads(mp.read_text())
    f = next(x for x in m["files"] if x["role"] == role)
    return pd.read_csv(mp.parent / f["name"], dtype=str, keep_default_na=False, na_values=[""])


# ---------------------------------------------------------------------------
# The fixture passes every check and produces results
# ---------------------------------------------------------------------------

def test_fixture_validates_and_runs(bundle):
    res = pa5.run(str(bundle), allow_synthetic=True)
    assert res["is_synthetic_fixture"] is True
    assert len(res["integrity_checks_passed"]) == 5
    fl = res["flow"]
    assert fl["cases_in_bundle"] == 40
    assert fl["cases_not_reviewed"] == 1 and fl["cases_reviewed_by_one"] == 1 and fl["cases_reviewed_by_two"] == 38
    assert fl["independent_judgment_rows"] == (38 * 2 + 1) * 19
    assert set(res["accuracy"]) == set(pa5.DENOMINATOR_RULES_V5)
    e1 = res["accuracy"]["R0_primary"]["estimands"]["E1_PPV_T0_POOLED"]["design_weighted"]
    assert e1["estimable"] and 0 < e1["estimate"] <= 1 and e1["ci_low"] <= e1["estimate"] <= e1["ci_high"]


def test_three_states_are_kept_apart(bundle):
    res = pa5.run(str(bundle), allow_synthetic=True)
    st = res["flow"]["reference_states_by_family"]
    assert sum(v for k, v in st.items() if k.endswith("|NOT_REVIEWED")) == 19          # one case x 19 items
    assert sum(v for k, v in st.items() if k.endswith("|UNRESOLVED")) == 1
    assert sum(v for k, v in st.items() if k.endswith("|NOT_APPLICABLE_NOT_SHOWN")) > 0
    assert not any(k.startswith(("AREA|NOT_APPLICABLE", "FIG2_ROW|NOT_APPLICABLE")) for k in st)
    assert sum(st.values()) == 40 * 19


# ---------------------------------------------------------------------------
# Refusals: nothing is computed when the bundle breaks the contract
# ---------------------------------------------------------------------------

def test_refuses_synthetic_without_flag(bundle):
    with pytest.raises(pa5.ExportError, match="synthetic fixture"):
        pa5.run(str(bundle))


def test_refuses_synthetic_ids_mislabeled_as_study_data(bundle):
    # The opt-in permits testing; it must never remove the mandatory synthetic
    # output marking or enable an unmarked manuscript block.
    data, manifest = _load(bundle)
    manifest["is_synthetic_fixture"] = False
    with pytest.raises(pa5.ExportError, match="case IDs contradict is_synthetic_fixture"):
        pa5.validate_bundle(data, manifest, allow_synthetic=True)


@pytest.mark.parametrize("flag", [None, "", "unknown"])
def test_refuses_unknown_synthetic_marker(bundle, flag):
    data, manifest = _load(bundle)
    manifest["is_synthetic_fixture"] = flag
    with pytest.raises(pa5.ExportError, match="explicit boolean"):
        pa5.validate_bundle(data, manifest, allow_synthetic=True)


@pytest.mark.parametrize("replace_all", [False, True])
def test_refuses_mixed_or_real_ids_in_synthetic_bundle(bundle, replace_all):
    data, manifest = _load(bundle)
    ids = sorted(data["frozen_labels"].case_id.unique())
    # Invent format-only identifiers in memory. No actual trial or study record
    # is read, and no real-format identifiers are stored in repository fixtures.
    selected = ids if replace_all else ids[:1]
    replacements = {case_id: "TLV5-" + str(i + 1).zfill(3)
                    for i, case_id in enumerate(selected)}
    for df in data.values():
        df["case_id"] = df.case_id.replace(replacements)
    expected = "case IDs contradict" if replace_all else "cannot be mixed"
    with pytest.raises(pa5.ExportError, match=expected):
        pa5.validate_bundle(data, manifest, allow_synthetic=True)


def test_synthetic_results_cannot_render_unmarked_manuscript(bundle):
    result = pa5.run(str(bundle), allow_synthetic=True)
    with pytest.raises(pa5.ExportError, match="refusing to render"):
        pa5.render_manuscript_block(result, "{{N_CASES_SAMPLED}}")
    block, _ = pa5.render_manuscript_block(result, "{{N_CASES_SAMPLED}}", allow_synthetic=True)
    assert block.startswith("SYNTHETIC OR PILOT TEST OUTPUT. NOT STUDY RESULTS.")


@pytest.mark.parametrize("column,value,message", [
    ("frame_stratum_size", "inf", "finite"),
    ("n_sampled_in_stratum", "nan", "finite"),
    ("selection_probability", "inf", "finite"),
    ("sampling_weight", "-inf", "finite"),
    ("frame_stratum_size", "-20", "positive integer"),
    ("frame_stratum_size", "200.5", "positive integer"),
    ("n_sampled_in_stratum", "0", "positive integer"),
    ("n_sampled_in_stratum", "20.5", "positive integer"),
    ("selection_probability", "0", "greater than zero"),
    ("selection_probability", "1.1", "at most one"),
    ("sampling_weight", "0.9", "at least one"),
])
def test_refuses_invalid_sampling_domains(bundle, column, value, message):
    data, manifest = _load(bundle)
    data["frozen_labels"][column] = value
    with pytest.raises(pa5.ExportError, match=message):
        pa5.validate_bundle(data, manifest, allow_synthetic=True)


def test_refuses_sampling_more_trials_than_the_population(bundle):
    # These values satisfy both reciprocal equations; algebra alone cannot
    # establish a valid sampling design or finite-population correction.
    data, manifest = _load(bundle)
    labels = data["frozen_labels"]
    labels["frame_stratum_size"] = "1"
    labels["selection_probability"] = labels.n_sampled_in_stratum.astype(float).astype(str)
    labels["sampling_weight"] = (1 / labels.n_sampled_in_stratum.astype(float)).astype(str)
    with pytest.raises(pa5.ExportError, match="sampled count cannot exceed"):
        pa5.validate_bundle(data, manifest, allow_synthetic=True)


def test_complete_census_is_a_valid_sampling_boundary(bundle):
    data, manifest = _load(bundle)
    labels = data["frozen_labels"]
    labels["frame_stratum_size"] = labels.n_sampled_in_stratum
    labels["selection_probability"] = "1"
    labels["sampling_weight"] = "1"
    validated, _ = pa5.validate_bundle(data, manifest, allow_synthetic=True)
    assert (validated["cases"].sampling_weight == 1).all()


@pytest.mark.parametrize("column", ["nct_id", "frame", "stratum", "variance_stratum", "design_version"])
def test_refuses_missing_design_identity(bundle, column):
    data, manifest = _load(bundle)
    data["frozen_labels"][column] = ""
    with pytest.raises(pa5.ExportError, match=f"{column} is required"):
        pa5.validate_bundle(data, manifest, allow_synthetic=True)


@pytest.mark.parametrize("column", ["dev_linked", "tier1_eligible"])
def test_refuses_missing_development_eligibility_flags(bundle, column):
    data, manifest = _load(bundle)
    data["frozen_labels"][column] = ""
    with pytest.raises(pa5.ExportError, match="explicit booleans"):
        pa5.validate_bundle(data, manifest, allow_synthetic=True)


def test_refuses_duplicate_trial_under_different_cases(bundle):
    data, manifest = _load(bundle)
    labels = data["frozen_labels"]
    cases = sorted(labels.case_id.unique())
    labels.loc[labels.case_id == cases[1], "nct_id"] = labels.loc[labels.case_id == cases[0], "nct_id"].iloc[0]
    with pytest.raises(pa5.ExportError, match="trial cannot appear under multiple case IDs"):
        pa5.validate_bundle(data, manifest, allow_synthetic=True)


def test_refuses_judgments_from_a_different_trial(bundle):
    data, manifest = _load(bundle)
    data["independent_judgments"].loc[0, "nct_id"] = "SYN-NCT-WRONG-TRIAL"
    with pytest.raises(pa5.ExportError, match="trial identifiers differ"):
        pa5.validate_bundle(data, manifest, allow_synthetic=True)


def test_refuses_unlocked_reference(bundle):
    _rewrite(bundle, "frozen_labels", manifest_update={"reference_locked": False})
    with pytest.raises(pa5.ExportError, match="not locked"):
        pa5.run(str(bundle), allow_synthetic=True)


def test_refuses_pilot_bundle_without_flag(bundle):
    _rewrite(bundle, "frozen_labels", manifest_update={"mode": "PILOT"})
    with pytest.raises(pa5.ExportError, match="pipeline dry run"):
        pa5.run(str(bundle), allow_synthetic=True)


def test_refuses_tampered_file(bundle):
    m = json.loads(bundle.read_text())
    f = next(x for x in m["files"] if x["role"] == "frozen_labels")
    p = bundle.parent / f["name"]
    p.write_text(p.read_text().replace(",YES,", ",NO,", 1))
    with pytest.raises(pa5.ExportError, match="SHA-256 mismatch"):
        pa5.run(str(bundle), allow_synthetic=True)


def test_refuses_label_change_after_freeze(bundle):
    L = _df(bundle, "frozen_labels")
    i = L.index[(L.item_code == "AREA_ONCOLOGY")][0]
    L.loc[i, "label_primary"] = "NO" if L.loc[i, "label_primary"] == "YES" else "YES"
    _rewrite(bundle, "frozen_labels", L)
    with pytest.raises(pa5.ExportError, match="label set hashed at the freeze"):
        pa5.run(str(bundle), allow_synthetic=True)


def test_refuses_calibration_case(bundle):
    J = _df(bundle, "independent_judgments")
    J.loc[J.index[:19], "case_id"] = "CAL5-TESTFX-01"
    _rewrite(bundle, "independent_judgments", J)
    with pytest.raises(pa5.ExportError, match="CAL5-"):
        pa5.run(str(bundle), allow_synthetic=True)


def test_refuses_missing_column(bundle):
    A = _df(bundle, "adjudicated_reference").drop(columns=["adjudication_blinded"])
    _rewrite(bundle, "adjudicated_reference", A)
    with pytest.raises(pa5.ExportError, match="columns differ"):
        pa5.run(str(bundle), allow_synthetic=True)


def test_refuses_not_applicable_on_an_area_item(bundle):
    J = _df(bundle, "independent_judgments")
    i = J.index[J.item_code == "AREA_CARDIOVASCULAR"][0]
    J.loc[i, "answer_effective_preclose"] = "NOT_APPLICABLE"
    J.loc[i, "answer_initial"] = "NOT_APPLICABLE"
    _rewrite(bundle, "independent_judgments", J)
    with pytest.raises(pa5.ExportError, match="outside the item scale"):
        pa5.run(str(bundle), allow_synthetic=True)


def test_refuses_subgroup_answer_without_a_yes_row(bundle):
    J = _df(bundle, "independent_judgments")
    hidden = J[(J.item_code == "SG_DIABETES_TYPE") & (J.answer_effective_preclose == "NOT_APPLICABLE")].index[0]
    J.loc[hidden, ["answer_initial", "answer_effective_preclose"]] = "TYPE_2"
    _rewrite(bundle, "independent_judgments", J)
    with pytest.raises(pa5.ExportError, match="answered exactly when the same reviewer answered"):
        pa5.run(str(bundle), allow_synthetic=True)


def test_refuses_investigator_adjudication(bundle):
    A = _df(bundle, "adjudicated_reference")
    i = A.index[A.adjudicator_role == "ADJUDICATOR"][0]
    A.loc[i, "adjudicator_role"] = "INVESTIGATOR"
    _rewrite(bundle, "adjudicated_reference", A)
    with pytest.raises(pa5.ExportError, match="ADJUDICATOR role"):
        pa5.run(str(bundle), allow_synthetic=True)


def test_refuses_rule_reference_that_differs_from_the_reviewers(bundle):
    A = _df(bundle, "adjudicated_reference")
    i = A.index[(A.adjudication_status == "CONCORDANT_ADOPTED_BY_RULE") & A.item_code.str.startswith("AREA_")][0]
    A.loc[i, "reference_answer"] = "NO" if A.loc[i, "reference_answer"] == "YES" else "YES"
    _rewrite(bundle, "adjudicated_reference", A)
    with pytest.raises(pa5.ExportError, match="rule reference differs"):
        pa5.run(str(bundle), allow_synthetic=True)


def test_refuses_adjudication_after_the_lock(bundle):
    A = _df(bundle, "adjudicated_reference")
    i = A.index[A.adjudicator_role == "ADJUDICATOR"][0]
    A.loc[i, "adjudicated_at"] = "2026-12-31T00:00:00Z"
    _rewrite(bundle, "adjudicated_reference", A)
    with pytest.raises(pa5.ExportError, match="between the snapshot and the reference lock"):
        pa5.run(str(bundle), allow_synthetic=True)


def test_refuses_wrong_weight(bundle):
    L = _df(bundle, "frozen_labels")
    L.loc[L.case_id == L.case_id.iloc[0], "sampling_weight"] = "1.0"
    # keep the label hash valid: the weight is not part of the label row text
    _rewrite(bundle, "frozen_labels", L)
    with pytest.raises(pa5.ExportError, match="sampling_weight must equal"):
        pa5.run(str(bundle), allow_synthetic=True)


# ---------------------------------------------------------------------------
# Estimation
# ---------------------------------------------------------------------------

def test_weighted_estimate_equals_direct_hajek_and_v3_function(bundle):
    data, manifest = _load(bundle)
    V, _ = pa5.validate_bundle(data, manifest, allow_synthetic=True)
    T = pa5.trial_table(V, "R0_primary")
    num, den = pa5.estimand_vectors(T)["E1_PPV_T0_POOLED"]
    direct = float((T.weight * num).sum() / (T.weight * den).sum())
    got = pa5.estimate(num, den, T)["design_weighted"]
    assert math.isclose(got["estimate"], direct, rel_tol=1e-12)
    Nh = T.groupby("variance_stratum").N_h.first().to_dict()
    v3 = pa3.weighted_ratio_v3(num, den, T.weight.to_numpy(float), T.variance_stratum.to_numpy(object), Nh)
    assert math.isclose(got["ci_low"], v3["ci_low"], rel_tol=1e-12) and math.isclose(got["ci_high"], v3["ci_high"], rel_tol=1e-12)


def test_nonresponse_adjustment_within_stratum(bundle):
    data, manifest = _load(bundle)
    V, _ = pa5.validate_bundle(data, manifest, allow_synthetic=True)
    T = pa5.trial_table(V, "R0_primary")
    s4 = T[T.variance_stratum == "SYN_S4"]
    assert len(s4) == 7 and np.allclose(s4.weight, 100 / 7)          # 8 sampled, 7 reviewed
    s1 = T[T.variance_stratum == "SYN_S1"]
    assert np.allclose(s1.weight, 400 / 12)                          # design weight when every case was reviewed


def test_perfect_reference_gives_one(tmp_path):
    mp = fx.write(str(tmp_path / "p"), scenario="perfect", overwrite=True)
    res = pa5.run(str(mp), allow_synthetic=True)
    est = res["accuracy"]["R0_primary"]["estimands"]
    for k in ("E1_PPV_T0_POOLED", "E4_SENS_T0_POOLED", "E5_SPEC_T0_POOLED", "E6_EXACT_MATCH_T0", "E10_PPV_ROW_LABELS_POOLED",
              "E8_RULE_D_AGREEMENT", "E9_RULE_K_AGREEMENT"):
        w = est[k]["design_weighted"]
        assert w["estimable"] and math.isclose(w["estimate"], 1.0), k


def test_denominator_rules_move_context_dependent_answers(bundle):
    data, manifest = _load(bundle)
    V, _ = pa5.validate_bundle(data, manifest, allow_synthetic=True)
    A = V["reference"]
    cd = A[(A.reference_answer == "CONTEXT_DEPENDENT") & A.item_code.str.startswith("AREA_")]
    assert len(cd) > 0
    c, item = cd.case_id.iloc[0], cd.item_code.iloc[0]
    r0, r1, r2 = (pa5.trial_table(V, r).loc[c] for r in pa5.DENOMINATOR_RULES_V5)
    assert (r0[f"Y_{item}"], r0[f"D_{item}"]) == (0, 0)
    assert (r1[f"Y_{item}"], r1[f"D_{item}"]) == (1, 1)
    assert (r2[f"Y_{item}"], r2[f"D_{item}"]) == (0, 1)


def test_unresolved_is_never_determinate(bundle):
    data, manifest = _load(bundle)
    V, _ = pa5.validate_bundle(data, manifest, allow_synthetic=True)
    A = V["reference"]
    u = A[A.adjudication_status == "UNRESOLVED_ESCALATED"].iloc[0]
    for r in pa5.DENOMINATOR_RULES_V5:
        row = pa5.trial_table(V, r).loc[u.case_id]
        assert row[f"D_{u.item_code}"] == 0


def test_rule_mappings():
    T = pd.DataFrame({"RULE_D": ["D1_KEEP_TYPE2", "D1_KEEP_TYPE2", "D4A_KEEP_UNRESOLVED_PARENT_ONLY", "D2_REMOVE_OTHER_TYPE", None],
                      "SG_DIABETES_TYPE": ["TYPE_2", "OTHER", "UNCLEAR", "TYPE_1", "TYPE_2"],
                      "RULE_K": ["K_KEEP_MALIGNANT_COMPATIBLE", "K_KEEP_HEURISTIC_NONMALIGNANT_CLASS", None, None, "K_REMOVE_VERIFIED_NONMALIGNANT"],
                      "SG_NEOPLASM_MALIGNANCY": ["MALIGNANT", "NON_MALIGNANT", "MALIGNANT", None, "NOT_APPLICABLE"]})
    for a in pa5.AREA_ITEMS:
        for p in ("T0_", "T1_", "Y_", "D_"):
            T[p + a] = 0
    for r in pa5.ROW_ITEMS:
        for p in ("R_", "Y_", "D_"):
            T[p + r] = 0
    T["tier1_eligible"] = False
    v = pa5.estimand_vectors(T)
    assert list(v["E8_RULE_D_AGREEMENT"][1]) == [1, 1, 0, 1, 0]       # UNCLEAR and no rule row excluded
    assert list(v["E8_RULE_D_AGREEMENT"][0]) == [1, 0, 0, 1, 0]       # OTHER disagrees with a keep; TYPE_1 agrees with a removal
    assert list(v["E9_RULE_K_AGREEMENT"][1]) == [1, 1, 0, 0, 0]       # NOT_APPLICABLE and missing excluded
    assert list(v["E9_RULE_K_AGREEMENT"][0]) == [1, 0, 0, 0, 0]


def test_tier1_eligible_estimate_is_flagged_or_not_estimable(bundle):
    res = pa5.run(str(bundle), allow_synthetic=True)
    e7 = res["accuracy"]["R0_primary"]["estimands"]["E7_PPV_T1V12_POOLED_ELIGIBLE"]["design_weighted"]
    if e7.get("n_domain_unweighted", 0) < pa5.MIN_UNITS_FOR_WEIGHTED:
        assert e7["estimable"] is False
    assert "OPTIMISTIC" in res["accuracy"]["R0_primary"]["estimands"]["E7b_PPV_T1V12_POOLED_ALL_OPTIMISTIC"]["description"]
    assert "PROVISIONAL" in res["labels"]["tier1"]


def test_reviewer_agreement_is_labelled_consistency(bundle):
    res = pa5.run(str(bundle), allow_synthetic=True)
    rc = res["reviewer_consistency"]
    assert "not validation" in rc["label"]
    eff = rc["answer_effective_preclose"]
    assert eff["n_double_reviewed_cases"] == 38
    assert set(eff["items"]) == set(pa5.REVIEWER_ITEMS)


def test_label_hash_follows_the_sampling_script_procedure():
    L = pd.DataFrame({"label_set_id": ["S", "S"], "case_id": ["TLV5-TESTFX-0002", "TLV5-TESTFX-0001"], "item_code": ["AREA_ONCOLOGY", "FIG2_ROW_DIAB"],
                      "label_primary": ["YES", "NO"], "label_secondary": ["NO", None], "label_informational": [None, None]})
    rows = ["S|TLV5-TESTFX-0001|FIG2_ROW_DIAB|NO||", "S|TLV5-TESTFX-0002|AREA_ONCOLOGY|YES|NO|"]
    expect = hashlib.sha256("\n".join(hashlib.sha256(r.encode()).hexdigest() for r in rows).encode()).hexdigest()
    assert pa5.label_rows_sha256(L) == expect


# ---------------------------------------------------------------------------
# Manuscript block and CLI
# ---------------------------------------------------------------------------

TEMPLATE = "Tier 0 PPV {{PPV_T0_POOLED_W}}; {{N_CASES_SAMPLED}} trials sampled."


def test_manuscript_block_refuses_synthetic_and_labels_it(bundle):
    res = pa5.run(str(bundle), allow_synthetic=True)
    with pytest.raises(pa5.ExportError):
        pa5.render_manuscript_block(res, TEMPLATE)
    block, trace = pa5.render_manuscript_block(res, TEMPLATE, allow_synthetic=True)
    assert block.startswith("SYNTHETIC OR PILOT TEST OUTPUT") and "40 trials sampled" in block and len(trace) == 2
    with pytest.raises(pa3.MissingResultError):
        pa5.render_manuscript_block(res, "{{NOT_A_SLOT}}", allow_synthetic=True)


def test_template_slots_are_all_defined():
    tpl = HERE / "fixtures" / "clinical_review_results_template_v5.md"
    if not tpl.exists():
        pytest.skip("template not in this checkout")
    import re
    slots = set(re.findall(r"\{\{([A-Z0-9_]+)\}\}", tpl.read_text()))
    assert slots and slots <= set(pa5.SLOT_MAP_V5)


def test_cli_refuses_to_overwrite(bundle, tmp_path):
    out = tmp_path / "out"
    assert pa5.main(["--manifest", str(bundle), "--out", str(out), "--allow-synthetic"]) == 0
    assert (out / "performance_results_v5.json").exists() and (out / "performance_estimates_v5.csv").exists()
    with pytest.raises(FileExistsError):
        pa5.main(["--manifest", str(bundle), "--out", str(out), "--allow-synthetic"])


def test_export_columns_match_the_database_views():
    """The column lists equal the 0004 export views (written by the PGlite suite into view_columns_v5.json)."""
    candidates = [HERE / "fixtures" / "view_columns_v5.json"]
    f = next((c for c in candidates if c.exists()), None)
    if f is None:
        pytest.skip("view_columns_v5.json not found (run the PGlite suite first)")
    cols = json.loads(f.read_text())
    strip = lambda xs: [x.split(":")[0] for x in xs]  # noqa: E731
    assert strip(cols["v_tlv5_independent_judgments"]) == pa5.JUDGMENT_COLUMNS_V5
    assert strip(cols["v_tlv5_adjudicated_reference"]) == pa5.REFERENCE_COLUMNS_V5
    assert strip(cols["v_tlv5_frozen_labels"]) == pa5.LABEL_COLUMNS_V5
