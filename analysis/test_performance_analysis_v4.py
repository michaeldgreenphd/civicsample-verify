"""SYNTHETIC ENGINEERING ONLY. Proposed analysis; no clinical study results."""

from __future__ import annotations

import copy
import hashlib
import json
import re
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from analysis import performance_analysis_v3 as pa3
from analysis import performance_analysis_v4 as pa4
from analysis.fixtures import make_synthetic_v4_bundle as fx

HERE = Path(__file__).resolve().parent
FIX = HERE / "fixtures"
MANIFEST = FIX / fx.MANIFEST_NAME
TEMPLATE = HERE / "fixtures" / "engineering_trace_template.md"


@pytest.fixture(scope="module")
def bundle():
    return pa4.load_bundle(str(MANIFEST))


def _copy(bundle):
    data, man = bundle
    return {k: v.copy() for k, v in data.items()}, copy.deepcopy(man)


def _validate(data, man, **kw):
    return pa4.validate_bundle(data, man, allow_synthetic=True, **kw)


def _results(data, man, **kw):
    M, passed = _validate(data, man, **kw)
    return pa4.build_results(M, man, passed)


def _rehash_case_list(data, man):
    man["frozen_sample_case_list_sha256"] = pa4.case_list_sha256(data["frozen_predictions"].case_id.unique())


def _align_adjudication_bases(data):
    """Keep intentionally altered test judgments and reference provenance consistent."""
    J, A = data["independent_judgments"], data["adjudicated_reference"]
    for i, row in A.iterrows():
        answers = J[(J.case_id == row.case_id) & (J.determination_level == row.determination_level)]
        matches = set(answers.loc[answers.decision_effective_preclose == row.adjudicated_decision, "reviewer_slot"])
        A.loc[i, "adjudication_basis"] = (
            "NONE" if pd.isna(row.adjudicated_decision) else
            "BOTH_REVIEWERS" if matches == {"1", "2"} else
            "REVIEWER_1" if "1" in matches else "REVIEWER_2" if "2" in matches else "NEITHER")


def _rename_case(data, old, new, category):
    for df in data.values():
        m = df.case_id == old
        df.loc[m, "case_id"] = new
        df.loc[m, "record_category"] = category


# ---------------------------------------------------------------------------
# Fixture and end-to-end
# ---------------------------------------------------------------------------

def test_fixture_regenerates_byte_identical(tmp_path):
    m1 = fx.write(tmp_path / "a")
    m2 = fx.write(tmp_path / "b")
    shipped = json.loads(MANIFEST.read_text(encoding="utf-8"))
    assert [f["sha256"] for f in m1["files"]] == [f["sha256"] for f in m2["files"]] == [f["sha256"] for f in shipped["files"]]
    assert (tmp_path / "a" / fx.MANIFEST_NAME).read_bytes() == MANIFEST.read_bytes()


def test_end_to_end_counts_and_labels(bundle):
    data, man = _copy(bundle)
    res = _results(data, man)
    P = data["frozen_predictions"]
    assert res["counts"]["cases"] == P.case_id.nunique()
    assert res["counts"]["record_categories"] == {"HELDOUT_FORMAL": P.case_id.nunique()}
    assert res["counts"]["independent_judgments"] == len(data["independent_judgments"])
    assert res["tier1_version_evaluated"] == man["tier1_version_frozen"]
    assert "PROVISIONAL" in res["tier1_label"]
    assert len(res["integrity_checks_passed"]) == 8
    assert any("Tier 1 additions" in s for s in res["not_estimable_by_design"])


def test_removal_only_labels_do_not_change_paired_values_or_denominators(bundle):
    data, man = _copy(bundle)
    merged, passed = _validate(data, man)
    results = pa4.build_results(merged, man, passed)
    # The adversarial fixture includes both directions; interpretation must not silently
    # discard additions or redefine a sensitivity/specificity denominator.
    predictions = data["frozen_predictions"]
    assert ((predictions.tier0_binary == "EXCLUDE") & (predictions.tier1_binary == "INCLUDE")).any()
    assert ((predictions.tier0_binary == "INCLUDE") & (predictions.tier1_binary == "EXCLUDE")).any()
    for level in ("DESCRIPTOR_LEVEL", "TRIAL_LEVEL"):
        expected = pa3.paired_comparison(merged, level, "VALIDATION_HELDOUT", "R0_primary")
        actual = copy.deepcopy(results["paired_comparison"][level])
        assert actual.pop("interpretation_scope") == "REMOVAL_ONLY"
        assert actual.pop("tier1_addition_accuracy_estimable") is False
        assert "does not filter" in actual.pop("interpretation_notice")
        for metric in ("sensitivity", "specificity"):
            for suffix in ("", "_weighted"):
                quantity = actual[f"{metric}_difference_curated_minus_original{suffix}"]
                assert quantity.pop("label").startswith(f"Removal-only {metric} difference:")
                assert quantity.pop("interpretation_scope") == "REMOVAL_ONLY"
        assert pa3._jsonable(actual) == pa3._jsonable(expected)
    assert "additions is not estimable" in results["labels"]["paired_differences"]


@pytest.mark.parametrize("phrase", [
    "Tier 1 sensitivity gain", "TIER 1 SENSITIVITY GAIN", "Tier-1 sensitivity gain",
    "Tier 1's sensitivity gain", "Tier 1’s sensitivity gain", "Tier 1 **sensitivity gain**",
])
def test_render_refuses_addition_gain_claim(bundle, phrase):
    data, man = _copy(bundle)
    results = _results(data, man)
    with pytest.raises(pa4.ExportError, match="unsupported improvement from additions"):
        pa4.render_manuscript_block(results, phrase + ": fictional test output", allow_synthetic=True)


def test_hand_computed_confusion_and_discordant_counts(bundle):
    data, man = _copy(bundle)
    res = _results(data, man)
    P, A = data["frozen_predictions"], data["adjudicated_reference"]
    d = P[P.determination_level == "DESCRIPTOR_LEVEL"].merge(A, on=["case_id", "determination_level"])
    ref = d.adjudicated_decision
    keep = ref.isin(["INCLUDE", "EXCLUDE"])
    for col, key in (("tier0_binary", "original_technical"), ("tier1_binary", "curated_v11")):
        ix = d[col]
        hand = {"tp": int(((ix == "INCLUDE") & (ref == "INCLUDE") & keep).sum()),
                "fp": int(((ix == "INCLUDE") & (ref == "EXCLUDE") & keep).sum()),
                "fn": int(((ix == "EXCLUDE") & (ref == "INCLUDE") & keep).sum()),
                "tn": int(((ix == "EXCLUDE") & (ref == "EXCLUDE") & keep).sum())}
        assert res["accuracy"]["DESCRIPTOR_LEVEL"]["R0_primary"][key]["confusion"] == hand
    disc = (d.tier0_binary != d.tier1_binary) & keep
    pc = res["paired_comparison"]["DESCRIPTOR_LEVEL"]
    assert pc["discordant_units"] == int(disc.sum())
    assert pc["discordant_curated_correct"] == int((disc & (d.tier1_binary == ref)).sum())
    assert pc["discordant_original_correct"] == int((disc & (d.tier0_binary == ref)).sum())
    assert pc["discordant_units"] == pc["discordant_curated_correct"] + pc["discordant_original_correct"]


def test_denominator_rules_r0_r1_r2(bundle):
    data, man = _copy(bundle)
    acc = _results(data, man)["accuracy"]["DESCRIPTOR_LEVEL"]
    rc0 = acc["R0_primary"]["reference_counts"]
    nondir = rc0["CONTEXT_DEPENDENT"] + rc0["INSUFFICIENT_INFORMATION"]
    n0 = acc["R0_primary"]["curated_v11"]["n_binary_pairs"]
    assert nondir > 0
    assert acc["R1_bound_nondirectional_as_include"]["curated_v11"]["n_binary_pairs"] == n0 + nondir
    assert acc["R2_bound_nondirectional_as_exclude"]["curated_v11"]["n_binary_pairs"] == n0 + nondir
    c1 = acc["R1_bound_nondirectional_as_include"]["original_technical"]["confusion"]
    c0 = acc["R0_primary"]["original_technical"]["confusion"]
    assert c1["tp"] + c1["fn"] == c0["tp"] + c0["fn"] + nondir


def test_levels_kept_apart(bundle):
    data, man = _copy(bundle)
    res = _results(data, man)
    P = data["frozen_predictions"]
    n_desc = P[P.determination_level == "DESCRIPTOR_LEVEL"].case_id.nunique()
    n_trial = P[P.determination_level == "TRIAL_LEVEL"].case_id.nunique()
    assert res["accuracy"]["DESCRIPTOR_LEVEL"]["R0_primary"]["n_cases"] == n_desc
    assert res["accuracy"]["TRIAL_LEVEL"]["R0_primary"]["n_cases"] == n_trial
    assert set(res["reviewer_agreement"]) == {"ONTOLOGY_AREA|DESCRIPTOR_LEVEL", "ONTOLOGY_AREA|TRIAL_LEVEL",
                                              "ONTOLOGY_AREA|DESCRIPTOR_LEVEL_IN_TRIAL_CASE"}
    assert res["trial_two_step"]["n_with_both_steps"] == n_trial


def test_agreement_uses_independent_judgments_not_adjudication(bundle):
    data, man = _copy(bundle)
    base = _results(data, man)
    # (a) rewrite the adjudicator's decisions on discordant case levels: agreement unchanged, accuracy changes
    d2, m2 = _copy(bundle)
    A = d2["adjudicated_reference"]
    m = A.adjudication_status == "DISCORDANT_RESOLVED"
    A.loc[m, "adjudicated_decision"] = A.loc[m, "adjudicated_decision"].map(
        {"INCLUDE": "EXCLUDE", "EXCLUDE": "INCLUDE", "CONTEXT_DEPENDENT": "INCLUDE", "INSUFFICIENT_INFORMATION": "EXCLUDE"})
    _align_adjudication_bases(d2)
    r2 = _results(d2, m2)
    assert json.dumps(pa3._jsonable(r2["reviewer_agreement"]), sort_keys=True) == \
        json.dumps(pa3._jsonable(base["reviewer_agreement"]), sort_keys=True)
    assert r2["accuracy"]["DESCRIPTOR_LEVEL"]["R0_primary"]["curated_v11"]["confusion"] != \
        base["accuracy"]["DESCRIPTOR_LEVEL"]["R0_primary"]["curated_v11"]["confusion"]
    # (b) rewrite reviewer 2's answers on discordant case levels (they stay discordant): accuracy unchanged,
    #     agreement statistics change
    d3, m3 = _copy(bundle)
    J = d3["independent_judgments"]
    piv = J.pivot_table(index=["case_id", "determination_level"], columns="reviewer_slot",
                        values="decision_effective_preclose", aggfunc="first")
    for (cid, lvl), r in piv[piv["1"] != piv["2"]].iterrows():
        new = [c for c in pa4.L1_CODES if c not in (r["1"], r["2"])][0]
        m = (J.case_id == cid) & (J.determination_level == lvl) & (J.reviewer_slot == "2")
        J.loc[m, "decision_effective_preclose"] = new
        J.loc[m, "decision_initial"] = new
    _align_adjudication_bases(d3)
    r3 = _results(d3, m3)
    assert json.dumps(pa3._jsonable(r3["accuracy"]), sort_keys=True) == json.dumps(pa3._jsonable(base["accuracy"]), sort_keys=True)
    assert r3["reviewer_agreement"]["ONTOLOGY_AREA|DESCRIPTOR_LEVEL"]["all_sets"] != \
        base["reviewer_agreement"]["ONTOLOGY_AREA|DESCRIPTOR_LEVEL"]["all_sets"]


def test_initial_submissions_kept_and_counted(bundle):
    data, man = _copy(bundle)
    res = _results(data, man)
    J = data["independent_judgments"]
    J = J.assign(changed=pd.to_numeric(J.n_revisions_preclose) > 0)
    for level, g in J.groupby("determination_level"):
        hand = int(g.groupby("case_id").changed.any().sum())
        assert res["reviewer_agreement_initial_submissions"][level]["n_case_levels_with_any_revision"] == hand
    assert J.changed.any()


def test_equal_weights_reproduce_unweighted(bundle):
    data, man = _copy(bundle)
    P = data["frozen_predictions"]
    P["selection_probability"] = "0.5"
    P["sampling_weight"] = "2.0"
    res = _results(data, man)
    blk = res["accuracy"]["DESCRIPTOR_LEVEL"]["R0_primary"]["original_technical"]
    for metric in ("sensitivity", "specificity"):
        w = blk["design_weighted"][metric]["estimate"]
        u = blk["unweighted_sample_restricted"][metric]["estimate"]
        assert abs(w - u) < 1e-12


def test_per_area_threshold_respected(bundle):
    data, man = _copy(bundle)
    areas = _results(data, man)["per_area"]["DESCRIPTOR_LEVEL"]["areas"]
    assert areas
    for entry in areas.values():
        for key in ("original_technical", "curated_v11"):
            c = entry[key]["confusion"]
            dens = {"sensitivity": c["tp"] + c["fn"], "specificity": c["tn"] + c["fp"],
                    "ppv": c["tp"] + c["fp"], "npv": c["tn"] + c["fn"]}
            for metric, den in dens.items():
                if den < pa3.MIN_AREA_DENOMINATOR:
                    assert entry[key][metric]["reported"] is False
                else:
                    assert "reported" not in entry[key][metric]


def test_blinding_summary_reports_post_unblinding_without_substitution(bundle):
    data, man = _copy(bundle)
    res = _results(data, man)
    A = data["adjudicated_reference"]
    # blinding_summary counts adjudications with a decision; unresolved case levels carry no reference value
    hand = int(((A.post_unblinding_revision_exists == "true") & A.adjudicated_decision.notna()).sum())
    assert res["blinding"]["n_with_post_unblinding_revision"] == hand > 0
    assert res["blinding"]["n_adjudicator_exposed_to_index_labels"] == 0


def test_manuscript_block_refuses_synthetic_and_traces_every_number(bundle, tmp_path):
    data, man = _copy(bundle)
    res = _results(data, man)
    template = TEMPLATE.read_text(encoding="utf-8")
    with pytest.raises(pa3.ExportError, match="synthetic"):
        pa4.render_manuscript_block(res, template, allow_synthetic=False)
    block, trace = pa4.render_manuscript_block(res, template, allow_synthetic=True)
    assert block.startswith("SYNTHETIC TEST OUTPUT")
    assert "{{" not in block
    rendered = " ".join(trace.rendered.tolist())
    body = block.split("\n", 2)[-1].replace("Tier 0", "").replace("Tier 1", "")
    for num in re.findall(r"\d[\d,]*(?:\.\d+)?%?", body):
        assert num in rendered or num == "95", num
    with pytest.raises(pa3.MissingResultError):
        pa4.render_manuscript_block(res, template + " {{NOT_A_SLOT}}", allow_synthetic=True)
    res2 = json.loads(json.dumps(pa3._jsonable(res)))
    res2["accuracy"]["DESCRIPTOR_LEVEL"]["R0_primary"]["curated_v11"]["design_weighted"]["sensitivity"]["estimable"] = False
    with pytest.raises(pa3.MissingResultError):
        pa4.render_manuscript_block(res2, template, allow_synthetic=True)


def test_cli_writes_outputs(tmp_path, capsys):
    rc = pa4.main(["--manifest", str(MANIFEST), "--out", str(tmp_path / "out"), "--template", str(TEMPLATE), "--allow-synthetic"])
    assert rc == 0
    for f in ("performance_results_v4.json", "clinical_review_results_block_v4.md", "clinical_review_results_block_v4_trace.csv"):
        assert (tmp_path / "out" / f).exists()
    result = json.loads((tmp_path / "out" / "performance_results_v4.json").read_text())
    for level in ("DESCRIPTOR_LEVEL", "TRIAL_LEVEL"):
        for metric in ("sensitivity", "specificity"):
            for suffix in ("", "_weighted"):
                quantity = result["paired_comparison"][level][f"{metric}_difference_curated_minus_original{suffix}"]
                assert quantity["interpretation_scope"] == "REMOVAL_ONLY"
                assert "Removal-only" in quantity["label"]
    block = (tmp_path / "out" / "clinical_review_results_block_v4.md").read_text()
    assert pa4.REMOVAL_ONLY_NOTICE in block
    assert "Tier 1 sensitivity gain" not in block + capsys.readouterr().out


# ---------------------------------------------------------------------------
# Refusals: manifest and record categories
# ---------------------------------------------------------------------------

def test_refuses_synthetic_without_flag(bundle):
    data, man = _copy(bundle)
    with pytest.raises(pa3.ExportError, match="synthetic"):
        pa4.validate_bundle(data, man, allow_synthetic=False)


@pytest.mark.parametrize("key,value,msg", [("reference_locked", False, "not locked"), ("mode", "PILOT", "FORMAL"),
                                           ("export_format_version", "3.0", "4.0"), ("tier1_version_frozen", "v1.3", "tier1_version_frozen"),
                                           ("review_module", "BENCHMARK_COMPATIBILITY", "Module A")])
def test_refuses_bad_manifest(bundle, key, value, msg):
    data, man = _copy(bundle)
    man[key] = value
    with pytest.raises(pa3.ExportError, match=msg):
        _validate(data, man)


@pytest.mark.parametrize("category,new_id", [("DEVELOPMENT", "DEV4-TESTFX-0001"), ("RUBRIC_CALIBRATION", "CAL4-TESTFX-01"),
                                             ("SYNTHETIC_PILOT", "SYN-0001"), ("HELDOUT_RESERVE_NOT_ADOPTED", "HO4R-TESTFX-001")])
def test_refuses_non_heldout_records(bundle, category, new_id):
    data, man = _copy(bundle)
    _rename_case(data, "HO4-TESTFX-0002", new_id, category)
    _rehash_case_list(data, man)
    with pytest.raises(pa3.ExportError, match="never"):
        _validate(data, man)


def test_refuses_development_id_labelled_heldout(bundle):
    data, man = _copy(bundle)
    _rename_case(data, "HO4-TESTFX-0002", "DEV4-TESTFX-0002", "HELDOUT_FORMAL")
    _rehash_case_list(data, man)
    with pytest.raises(pa3.ExportError, match="DEV4-"):
        _validate(data, man)


def test_extension_requires_amendment(bundle):
    data, man = _copy(bundle)
    _rename_case(data, "HO4-TESTFX-0003", "HO4R-TESTFX-0001", "HELDOUT_EXTENSION_APPROVED")
    _rehash_case_list(data, man)
    with pytest.raises(pa3.ExportError, match="amendment"):
        _validate(data, man)
    man["extension_approved_by_amendment"] = True
    man["amendment_id"] = "FX-AMEND-1"
    res = _results(data, man)
    assert res["counts"]["record_categories"]["HELDOUT_EXTENSION_APPROVED"] == 1


# ---------------------------------------------------------------------------
# Refusals: frozen predictions and sample
# ---------------------------------------------------------------------------

def test_refuses_predictions_regenerated_after_freeze(tmp_path):
    out = tmp_path / "b"
    man = fx.write(out)
    pred = out / fx.FILE_NAMES["frozen_predictions"]
    text = pred.read_text(encoding="utf-8").replace("FX-PRED-4", "FX-PRED-5", 1)
    pred.write_text(text, encoding="utf-8")
    for f in man["files"]:
        if f["role"] == "frozen_predictions":
            f["sha256"] = hashlib.sha256(pred.read_bytes()).hexdigest()
    (out / fx.MANIFEST_NAME).write_text(json.dumps(man, indent=2) + "\n", encoding="utf-8")
    with pytest.raises(pa3.ExportError, match="hashed at the freeze"):
        pa4.load_bundle(str(out / fx.MANIFEST_NAME))


def test_refuses_tampered_file(tmp_path):
    out = tmp_path / "c"
    fx.write(out)
    j = out / fx.FILE_NAMES["independent_judgments"]
    j.write_text(j.read_text(encoding="utf-8").replace("FX-REV-A", "FX-REV-Z", 1), encoding="utf-8")
    with pytest.raises(pa3.ExportError, match="SHA-256"):
        pa4.load_bundle(str(out / fx.MANIFEST_NAME))


def test_refuses_tier1_version_mismatch(bundle):
    data, man = _copy(bundle)
    data["frozen_predictions"].loc[0, "tier1_version"] = "v1.2"
    with pytest.raises(pa3.ExportError, match="frozen version"):
        _validate(data, man)


def test_refuses_prediction_recorded_after_freeze(bundle):
    data, man = _copy(bundle)
    data["frozen_predictions"].loc[0, "prediction_frozen_at"] = "2030-01-11T00:00:00Z"
    with pytest.raises(pa3.ExportError, match="after the freeze"):
        _validate(data, man)


def test_refuses_case_list_change_after_freeze(bundle):
    data, man = _copy(bundle)
    for k in data:
        data[k] = data[k][data[k].case_id != "HO4-TESTFX-0005"].reset_index(drop=True)
    with pytest.raises(pa3.ExportError, match="frozen sample case list"):
        _validate(data, man)


def test_refuses_case_lists_that_differ_across_files(bundle):
    data, man = _copy(bundle)
    J = data["independent_judgments"]
    data["independent_judgments"] = J[J.case_id != "HO4-TESTFX-0005"].reset_index(drop=True)
    with pytest.raises(pa3.ExportError, match="differ across files"):
        _validate(data, man)


def test_refuses_unadjudicated_case_level(bundle):
    data, man = _copy(bundle)
    A = data["adjudicated_reference"]
    drop = A[A.determination_level == "TRIAL_LEVEL"].index[0]
    data["adjudicated_reference"] = A.drop(index=drop).reset_index(drop=True)
    with pytest.raises(pa3.ExportError, match="every case level is adjudicated"):
        _validate(data, man)


def test_refuses_development_provenance(bundle):
    data, man = _copy(bundle)
    data["frozen_predictions"].loc[3, "provenance_audit_result"] = "DEVELOPMENT_FLAG"
    with pytest.raises(pa3.ExportError, match="NO_DEVELOPMENT_FLAG"):
        _validate(data, man)


def test_refuses_weight_probability_mismatch(bundle):
    data, man = _copy(bundle)
    data["frozen_predictions"].loc[4, "sampling_weight"] = "3.0"
    with pytest.raises(pa3.ExportError, match="sampling_weight"):
        _validate(data, man)


def test_refuses_mapping_policy_inconsistency(bundle):
    data, man = _copy(bundle)
    P = data["frozen_predictions"]
    i = P[(P.determination_level == "DESCRIPTOR_LEVEL") & (P.tier1_status_raw == "EXCLUDE")].index[0]
    P.loc[i, "tier1_binary"] = "INCLUDE"
    with pytest.raises(pa3.ExportError, match="mapping policy"):
        _validate(data, man)
    d2, m2 = _copy(bundle)
    P2 = d2["frozen_predictions"]
    i2 = P2[P2.determination_level == "TRIAL_LEVEL"].index[0]
    P2.loc[i2, "tier1_binary"] = "INCLUDE" if P2.loc[i2, "tier1_binary"] == "EXCLUDE" else "EXCLUDE"
    with pytest.raises(pa3.ExportError, match="Stage C"):
        _validate(d2, m2)


# ---------------------------------------------------------------------------
# Refusals: judgments, adjudication, blinding
# ---------------------------------------------------------------------------

def test_refuses_adjudicator_who_reviewed(bundle):
    data, man = _copy(bundle)
    A = data["adjudicated_reference"]
    A.loc[A.index[A.adjudication_status == "DISCORDANT_RESOLVED"][0], "adjudicator_pseudo_id"] = fx.REVIEWERS[0]
    with pytest.raises(pa3.ExportError, match="separate person"):
        _validate(data, man)


def test_exposed_adjudication_refused_unless_allowed(bundle):
    data, man = _copy(bundle)
    data["adjudicated_reference"].loc[0, "adjudicator_exposed_to_index_labels"] = "true"
    with pytest.raises(pa3.ExportError, match="exposed"):
        _validate(data, man)
    res = _results(data, man, allow_exposed_reference=True)
    assert res["blinding"]["n_adjudicator_exposed_to_index_labels"] == 1


@pytest.mark.parametrize("frame,col,value,msg", [
    ("independent_judgments", "last_submitted_at", "2030-02-16T00:00:00Z", "formal phase"),
    ("independent_judgments", "first_submitted_at", "2030-01-14T00:00:00Z", "formal phase"),
    ("adjudicated_reference", "adjudicated_at", "2030-02-14T00:00:00Z", "close and the reference lock"),
    ("adjudicated_reference", "adjudicated_at", "2030-02-26T00:00:00Z", "close and the reference lock"),
    ("adjudicated_reference", "reference_lock_id", "FX-LOCK-OTHER", "reference lock"),
])
def test_refuses_out_of_window_records(bundle, frame, col, value, msg):
    data, man = _copy(bundle)
    data[frame].loc[0, col] = value
    with pytest.raises(pa3.ExportError, match=msg):
        _validate(data, man)


def test_accepts_recorded_unlock_before_freeze_when_judgments_follow_both(bundle):
    data, man = _copy(bundle)
    man["formal_phase_opened_at"] = "2030-01-09T00:00:00Z"
    _validate(data, man)


@pytest.mark.parametrize("timestamp", ["2030-01-08T23:00:00Z", "2030-01-09T12:00:00Z"])
def test_refuses_judgments_before_unlock_or_freeze(bundle, timestamp):
    data, man = _copy(bundle)
    man["formal_phase_opened_at"] = "2030-01-09T00:00:00Z"
    data["independent_judgments"].loc[0, "first_submitted_at"] = timestamp
    with pytest.raises(pa3.ExportError, match="before opening or freeze"):
        _validate(data, man)


@pytest.mark.parametrize("field,timestamp", [
    ("formal_phase_closed_at", "2030-01-09T12:00:00Z"),
    ("reference_locked_at", "2030-01-09T12:00:00Z"),
    ("reference_locked_at", "2030-02-14T12:00:00Z"),
])
def test_refuses_close_or_lock_before_readiness_or_lock_before_close(bundle, field, timestamp):
    data, man = _copy(bundle)
    man["formal_phase_opened_at"] = "2030-01-09T00:00:00Z"
    man[field] = timestamp
    with pytest.raises(pa3.ExportError, match="close and reference lock must follow"):
        _validate(data, man)


def test_refuses_reference_assessment_before_freeze_even_after_unlock(bundle):
    data, man = _copy(bundle)
    man["formal_phase_opened_at"] = "2030-01-09T00:00:00Z"
    data["adjudicated_reference"].loc[0, "adjudicated_at"] = "2030-01-09T12:00:00Z"
    with pytest.raises(pa3.ExportError, match="close and the reference lock"):
        _validate(data, man)


def test_refuses_duplicate_and_same_reviewer_judgments(bundle):
    data, man = _copy(bundle)
    J = data["independent_judgments"]
    data["independent_judgments"] = pd.concat([J, J.iloc[[0]]], ignore_index=True)
    with pytest.raises(pa3.ExportError, match="duplicate judgment"):
        _validate(data, man)
    d2, m2 = _copy(bundle)
    J2 = d2["independent_judgments"]
    J2.loc[J2.reviewer_slot == "2", "reviewer_pseudo_id"] = fx.REVIEWERS[0]
    with pytest.raises(pa3.ExportError, match="two different reviewers"):
        _validate(d2, m2)


def test_refuses_unrecorded_revision(bundle):
    data, man = _copy(bundle)
    J = data["independent_judgments"]
    i = J[J.n_revisions_preclose == "0"].index[0]
    J.loc[i, "decision_initial"] = "EXCLUDE" if J.loc[i, "decision_effective_preclose"] != "EXCLUDE" else "INCLUDE"
    with pytest.raises(pa3.ExportError, match="records no revision"):
        _validate(data, man)


def test_refuses_discordant_case_without_reason(bundle):
    data, man = _copy(bundle)
    M, _ = _validate(data, man)
    disc = M[M.double_reviewed & (M.reviewers_agree == False)]  # noqa: E712
    assert len(disc) > 0
    cid, lvl = disc.iloc[0].case_id, disc.iloc[0].determination_level
    A = data["adjudicated_reference"]
    A.loc[(A.case_id == cid) & (A.determination_level == lvl), "disagreement_reason_code"] = np.nan
    with pytest.raises(pa3.ExportError, match="reason code"):
        _validate(data, man)


def test_refuses_unresolved_with_decision(bundle):
    data, man = _copy(bundle)
    A = data["adjudicated_reference"]
    i = A.index[A.adjudication_status == "CONCORDANT_ADOPTED_BY_RULE"][0]
    A.loc[i, "adjudication_status"] = "UNRESOLVED_ESCALATED"
    with pytest.raises(pa3.ExportError, match="UNRESOLVED_ESCALATED"):
        _validate(data, man)


# ---------------------------------------------------------------------------
# Adjudication scope (D2: the adjudicator resolves disagreements) and single-reviewed case levels
# ---------------------------------------------------------------------------

def test_adjudication_scope_rules(bundle):
    data, man = _copy(bundle)
    res = _results(data, man)
    assert res["adjudication_scope"] == "DISAGREEMENTS_ONLY"
    assert res["adjudication_status_counts"]["CONCORDANT_ADOPTED_BY_RULE"] > 0
    man["adjudication_scope"] = "ALL_CASE_LEVELS"
    with pytest.raises(pa3.ExportError, match="none by rule"):
        _validate(data, man)
    d2, m2 = _copy(bundle)
    A = d2["adjudicated_reference"]
    i = A.index[A.adjudication_status == "CONCORDANT_ADOPTED_BY_RULE"][0]
    A.loc[i, ["adjudication_status", "adjudicator_pseudo_id", "adjudicator_role"]] = ["CONCORDANT_CONFIRMED", fx.ADJUDICATOR, "ADJUDICATOR"]
    with pytest.raises(pa3.ExportError, match="by rule only"):
        _validate(d2, m2)
    m2["adjudication_scope"] = "ALL_CASE_LEVELS"
    with pytest.raises(pa3.ExportError, match="none by rule"):   # the other rule rows remain
        _validate(d2, m2)


def test_status_must_match_reviewer_agreement(bundle):
    data, man = _copy(bundle)
    A = data["adjudicated_reference"]
    i = A.index[A.adjudication_status == "DISCORDANT_RESOLVED"][0]
    A.loc[i, ["adjudication_status", "adjudicator_pseudo_id", "adjudicator_role"]] = ["CONCORDANT_ADOPTED_BY_RULE", "RULE", "CONCORDANCE_RULE"]
    with pytest.raises(pa3.ExportError, match="did not agree"):
        _validate(data, man)
    d2, m2 = _copy(bundle)
    A2 = d2["adjudicated_reference"]
    j = A2.index[A2.adjudication_status == "CONCORDANT_ADOPTED_BY_RULE"][0]
    A2.loc[j, "adjudicated_decision"] = "INCLUDE" if A2.loc[j, "adjudicated_decision"] != "INCLUDE" else "EXCLUDE"
    with pytest.raises(pa3.ExportError, match="shared answer"):
        _validate(d2, m2)


def test_single_reviewed_case_level(bundle):
    data, man = _copy(bundle)
    A, J = data["adjudicated_reference"], data["independent_judgments"]
    i = A.index[A.adjudication_status == "DISCORDANT_RESOLVED"][0]
    cid, lvl = A.loc[i, "case_id"], A.loc[i, "determination_level"]
    data["independent_judgments"] = J[~((J.case_id == cid) & (J.determination_level == lvl) & (J.reviewer_slot == "2"))].reset_index(drop=True)
    with pytest.raises(pa3.ExportError, match="SINGLE_REVIEW_ADJUDICATED"):
        _validate(data, man)
    A.loc[i, ["adjudication_status", "disagreement_reason_code"]] = ["SINGLE_REVIEW_ADJUDICATED", np.nan]
    _align_adjudication_bases(data)
    res = _results(data, man)
    ra = res["reviewer_agreement"][f"ONTOLOGY_AREA|{lvl}"]
    assert ra["n_single_reviewed_excluded"] == 1
