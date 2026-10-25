"""Adversarial tests using synthetic records only; never connects to a database."""
import json
import sys
from pathlib import Path

import pandas as pd
import pytest

VAL = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(VAL), str(VAL / "fixtures")]
import make_synthetic_v8_bundle as MK
import mu8_bundle as B
import performance_analysis_v8 as PA


def bundle(tmp_path, setting="ALLOW"):
    return MK.write(MK.build(setting, 8), tmp_path / "bundle", setting)


def rewrite_csv(p, name, edit):
    frame = pd.read_csv(p / name, dtype=str, keep_default_na=False)
    edited = edit(frame)
    (frame if edited is None else edited).to_csv(p / name, index=False, lineterminator="\n")
    manifest = json.loads((p / "manifest.json").read_text())
    manifest["files"][name] = B.sha256_file(p / name)
    (p / "manifest.json").write_text(json.dumps(manifest))


@pytest.mark.parametrize("column,value", [("family", "ROW"), ("category", "HTN"),
                                         ("assignment_code", "IN_ROW")])
def test_reference_cannot_reclassify_a_frozen_unit(tmp_path, column, value):
    p = bundle(tmp_path)
    rewrite_csv(p, "final_reference.csv", lambda r: r.__setitem__(column, r[column].mask(r.index == 0, value)))
    with pytest.raises(PA.Refused, match="reference metadata"):
        PA.load_bundle(p, True, None)


def test_status_cannot_disguise_synthetic_design(tmp_path):
    p = bundle(tmp_path)
    m = json.loads((p / "manifest.json").read_text())
    m["status"] = "FORMAL"
    (p / "manifest.json").write_text(json.dumps(m))
    with pytest.raises(PA.Refused, match="allow-synthetic"):
        PA.load_bundle(p, False, None)
    assert PA.load_bundle(p, True, None)["synthetic"]


def test_real_design_disabled_even_when_allow_synthetic_is_passed(tmp_path):
    p = bundle(tmp_path)
    m = json.loads((p / "manifest.json").read_text())
    m["design"]["design_version"] = "review-design-v8.0.0"
    (p / "manifest.json").write_text(json.dumps(m))
    with pytest.raises(PA.Refused, match="synthetic-only"):
        PA.load_bundle(p, True, None)


@pytest.mark.parametrize("value", [0, -1, 2, "inf", "nan", "not-a-number"])
def test_invalid_probabilities_refused(tmp_path, value):
    p = bundle(tmp_path, "ONE_PER_TRIAL")
    frame = pd.read_csv(p / "unit_probabilities.csv", dtype=str)
    frame.loc[0, "pi_mc_ONE_PER_TRIAL"] = str(value)
    frame.to_csv(p / "unit_probabilities.csv", index=False)
    with pytest.raises(PA.Refused, match="finite and in"):
        PA.analysis_frame(PA.load_bundle(p, True, None), p / "unit_probabilities.csv")


def test_duplicate_probability_does_not_silently_replace_first_weight(tmp_path):
    p = bundle(tmp_path, "ONE_PER_TRIAL")
    frame = pd.read_csv(p / "unit_probabilities.csv")
    pd.concat([frame, frame.iloc[[0]]]).to_csv(p / "unit_probabilities.csv", index=False)
    with pytest.raises(PA.Refused, match="exactly one row"):
        PA.analysis_frame(PA.load_bundle(p, True, None), p / "unit_probabilities.csv")


@pytest.mark.parametrize("name", ["units.csv", "unit_design.csv", "final_reference.csv"])
def test_duplicate_unit_refused_before_join(tmp_path, name):
    p = bundle(tmp_path)
    rewrite_csv(p, name, lambda r: pd.concat([r, r.iloc[[0]]]))
    with pytest.raises(PA.Refused, match="unique"):
        PA.load_bundle(p, True, None)


def test_extra_judgment_cannot_enter_agreement(tmp_path):
    p = bundle(tmp_path)
    def extra(r):
        row = r.iloc[[0]].copy()
        row["unit_id"] = "SYN-EXTRA-UNIT"
        return pd.concat([r, row])
    rewrite_csv(p, "independent_judgments.csv", extra)
    with pytest.raises(PA.Refused, match="exactly the frozen units"):
        PA.load_bundle(p, True, None)


def test_pilot_category_refused_even_in_formal_bundle(tmp_path):
    p = bundle(tmp_path)
    rewrite_csv(p, "units.csv", lambda r: r.__setitem__("record_category", "MAPPING_UNIT_PILOT"))
    with pytest.raises(PA.Refused, match="pilot, training and development"):
        PA.load_bundle(p, True, None)


def test_one_per_trial_refuses_duplicate_trials_even_with_matching_hashes(tmp_path):
    p = bundle(tmp_path, "ONE_PER_TRIAL")
    d = pd.read_csv(p / "unit_design.csv", dtype=str, keep_default_na=False)
    d.loc[1, "nct_id"] = d.loc[0, "nct_id"]
    fields = ["unit_id", "nct_id", "frame_id", "stratum", "frame_stratum_size",
              "n_sampled_in_stratum", "allocation_option", "overlap_setting", "sampling_seed", "prn_key"]
    d["design_row_sha256"] = [B.sha256_text(B.design_row_text(*row)) for row in d[fields].itertuples(index=False, name=None)]
    d.to_csv(p / "unit_design.csv", index=False, lineterminator="\n")
    m = json.loads((p / "manifest.json").read_text())
    m["files"]["unit_design.csv"] = B.sha256_file(p / "unit_design.csv")
    m["freeze"]["design_rows_sha256"] = B.sha256_text("\n".join(d.sort_values("unit_id").design_row_sha256))
    (p / "manifest.json").write_text(json.dumps(m))
    with pytest.raises(PA.Refused, match="repeated trial"):
        PA.load_bundle(p, True, None)


@pytest.mark.parametrize("name", ["units.csv", "unit_design.csv", "independent_judgments.csv", "final_reference.csv"])
def test_nonformal_record_refused_inside_formal_bundle(tmp_path, name):
    p = bundle(tmp_path)
    rewrite_csv(p, name, lambda r: r.__setitem__("mode", "PILOT"))
    with pytest.raises(PA.Refused, match="non-FORMAL"):
        PA.load_bundle(p, True, None)


@pytest.mark.parametrize("column,value", [
    ("final_answer", "DISAGREE"), ("final_status", "UNRESOLVED"),
    ("routing", "ROUTED"), ("answer_initial_slot1", "DISAGREE"),
    ("answer_effective_slot2", "CANNOT_TELL"), ("adjudication_basis", "REVIEWER_1"),
])
def test_concordant_reference_cannot_override_judgments(tmp_path, column, value):
    p = bundle(tmp_path)
    def edit(r):
        i = r.index[r.routing == "CONCORDANT_AGREE"][0]
        r.loc[i, column] = value
    rewrite_csv(p, "final_reference.csv", edit)
    with pytest.raises(PA.Refused, match="reference|adjudication"):
        PA.load_bundle(p, True, None)


@pytest.mark.parametrize("column,value", [
    ("judgment_status", "NOT_ANSWERED"), ("judgment_status", "DRAFT"),
    ("uncertain_initial", ""), ("uncertain_effective", "yes"),
    ("answer_effective", "INVALID"), ("reason_initial", ""),
    ("n_revisions", "-1"), ("n_revisions", "0.5"),
    ("first_submitted_at", "yesterday"), ("last_submitted_at", "2000-01-01T00:00:00Z"),
    ("first_submitted_at", "2026-11-01T00:00:00"),
])
def test_invalid_judgment_cannot_enter_agreement(tmp_path, column, value):
    p = bundle(tmp_path)
    def edit(j):
        i = j.index[j.answer_initial == "DISAGREE"][0]
        j.loc[i, column] = value
    rewrite_csv(p, "independent_judgments.csv", edit)
    with pytest.raises(PA.Refused):
        PA.load_bundle(p, True, None)


@pytest.mark.parametrize("column,value", [("answer_initial", "AGREE"), ("uncertain_effective", "false"),
                                         ("n_revisions", "1"), ("note_effective", "synthetic content")])
def test_unanswered_assignment_remains_absent(tmp_path, column, value):
    p = bundle(tmp_path)
    def edit(j):
        j.loc[j.judgment_status == "NOT_ANSWERED", column] = value
    rewrite_csv(p, "independent_judgments.csv", edit)
    with pytest.raises(PA.Refused, match="unanswered assignments"):
        PA.load_bundle(p, True, None)


def test_changed_endpoint_requires_a_revision(tmp_path):
    p = bundle(tmp_path)
    def edit(j):
        i = j.index[(j.judgment_status == "ANSWERED") & (j.n_revisions == "0")][0]
        j.loc[i, "note_effective"] = "synthetic amendment without history"
    rewrite_csv(p, "independent_judgments.csv", edit)
    with pytest.raises(PA.Refused, match="without a revision"):
        PA.load_bundle(p, True, None)


@pytest.mark.parametrize("column,value", [("adjudication_basis", "NEITHER"),
                                         ("final_status", "CONCORDANT"),
                                         ("adjudication_status", ""),
                                         ("adjudication_disagreement_reason_code", "INVALID")])
def test_adjudication_must_match_its_basis_and_route(tmp_path, column, value):
    p = bundle(tmp_path)
    def edit(r):
        i = r.index[(r.final_status == "ADJUDICATED") & r.adjudication_basis.isin(["REVIEWER_1", "REVIEWER_2"])][0]
        r.loc[i, column] = value
    rewrite_csv(p, "final_reference.csv", edit)
    with pytest.raises(PA.Refused, match="adjudication|adjudicated"):
        PA.load_bundle(p, True, None)


@pytest.mark.parametrize("column,value", [("final_answer", "AGREE"), ("adjudication_basis", "REVIEWER_1"),
                                         ("adjudication_reason_code", "OTHER_SPECIFIED")])
def test_unresolved_reference_cannot_be_counted_as_confirmed(tmp_path, column, value):
    p = bundle(tmp_path)
    def edit(r):
        r.loc[r.final_status == "UNRESOLVED", column] = value
    rewrite_csv(p, "final_reference.csv", edit)
    with pytest.raises(PA.Refused, match="reference|adjudication"):
        PA.load_bundle(p, True, None)


@pytest.mark.parametrize("field", ["answer_effective", "uncertain_initial", "n_revisions"])
def test_missing_judgment_columns_refused(tmp_path, field):
    p = bundle(tmp_path)
    rewrite_csv(p, "independent_judgments.csv", lambda j: j.drop(columns=[field]))
    with pytest.raises(PA.Refused, match="required columns"):
        PA.load_bundle(p, True, None)


@pytest.mark.parametrize("field", ["row_counts", "n_units", "assignment_set_id", "overlap_setting"])
def test_manifest_cannot_misstate_export_counts_or_design(tmp_path, field):
    p = bundle(tmp_path)
    m = json.loads((p / "manifest.json").read_text())
    if field == "row_counts":
        m[field]["independent_judgments.csv"] = 199
    elif field == "n_units":
        m["freeze"][field] = 99
    else:
        m["design"][field] = "SYN-CHANGED"
    (p / "manifest.json").write_text(json.dumps(m))
    with pytest.raises(PA.Refused, match="count|manifest"):
        PA.load_bundle(p, True, None)


@pytest.mark.parametrize("column,value", [("frame_stratum_size", "9999"), ("n_sampled_in_stratum", "7")])
def test_stratum_sizes_cannot_vary_between_units_with_recomputed_hashes(tmp_path, column, value):
    p = bundle(tmp_path)
    d = pd.read_csv(p / "unit_design.csv", dtype=str, keep_default_na=False)
    d.loc[0, column] = value
    fields = ["unit_id", "nct_id", "frame_id", "stratum", "frame_stratum_size",
              "n_sampled_in_stratum", "allocation_option", "overlap_setting", "sampling_seed", "prn_key"]
    d["design_row_sha256"] = [B.sha256_text(B.design_row_text(*row)) for row in d[fields].itertuples(index=False, name=None)]
    d.to_csv(p / "unit_design.csv", index=False, lineterminator="\n")
    m = json.loads((p / "manifest.json").read_text())
    m["files"]["unit_design.csv"] = B.sha256_file(p / "unit_design.csv")
    m["freeze"]["design_rows_sha256"] = B.sha256_text("\n".join(d.sort_values("unit_id").design_row_sha256))
    (p / "manifest.json").write_text(json.dumps(m))
    with pytest.raises(PA.Refused, match="consistent within each stratum"):
        PA.load_bundle(p, True, None)


def test_design_version_cannot_change_in_one_row(tmp_path):
    p = bundle(tmp_path)
    def edit(d):
        d.loc[0, "design_version"] = "SYN-8-OTHER-FIXTURE"
    rewrite_csv(p, "unit_design.csv", edit)
    with pytest.raises(PA.Refused, match="manifest design"):
        PA.load_bundle(p, True, None)


def test_cli_refuses_contradiction_without_writing_results(tmp_path, capsys):
    p = bundle(tmp_path)
    def edit(r):
        r.loc[r.routing == "BOTH_CANNOT_TELL", "final_answer"] = "AGREE"
    rewrite_csv(p, "final_reference.csv", edit)
    out = tmp_path / "results"
    assert PA.main(["--bundle", str(p), "--out", str(out), "--allow-synthetic"]) == 3
    assert not out.exists()
    assert "REFUSED: final reference" in capsys.readouterr().err
