"""
validation/tests/test_performance_analysis_v8.py  (review design v8; synthetic bundles only)

Run: python -m pytest -q validation/tests/test_performance_analysis_v8.py
The database-written bundle test needs a bundle that the application's own database suite writes for design v8 (the app
repository, after the v8 migrations). It is read from fixtures/db_bundle_v8_synthetic/ or from the folder named by
MU8_DB_BUNDLE; when neither exists the test fails, unless MU8_ALLOW_NO_DB_BUNDLE=1 is set (then it is skipped and the
skip is reported).
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

import pandas as pd
import pytest

HERE = Path(__file__).resolve().parent
VAL = HERE.parent
sys.path.insert(0, str(VAL))
sys.path.insert(0, str(VAL / "fixtures"))
import mu8_bundle as B  # noqa: E402
import mu8_estimators as E  # noqa: E402
import performance_analysis_v8 as PA  # noqa: E402
import make_synthetic_v8_bundle as MK  # noqa: E402


def make(tmp_path, setting="ALLOW", seed=8) -> Path:
    return MK.write(MK.build(setting, seed), tmp_path / f"bundle_{setting}_{seed}", setting)


def run(tmp_path, bundle, *extra, name="out"):
    out = tmp_path / name
    rc = PA.main(["--bundle", str(bundle), "--out", str(out), "--bootstrap-reps", "200", *extra])
    return rc, out


def independent_hajek(bundle: Path, family, rule: str, weights=None, categories=None) -> float:
    """The estimate recomputed directly from the CSV files, without the analysis code."""
    D = pd.read_csv(bundle / "unit_design.csv", dtype=str, keep_default_na=False)
    R = pd.read_csv(bundle / "final_reference.csv", dtype=str, keep_default_na=False)
    X = D.merge(R[["unit_id", "family", "category", "final_answer", "final_status"]], on="unit_id")
    X = X[X.family == family]
    if categories is not None:
        X = X[X.category.isin(categories)]
    X = X[X.final_status != "INCOMPLETE"]
    r_h = X.groupby("stratum").unit_id.transform("size")
    w = X.frame_stratum_size.astype(float) / r_h if weights is None else X.unit_id.map(weights)
    d = X.final_answer.isin(["AGREE", "DISAGREE"]) if rule == "R0" else pd.Series(True, index=X.index)
    y = X.final_answer == "AGREE"
    return float((w * d * y).sum() / (w * d).sum())


# ---------------------------------------------------------------------------------------------------------------------
def test_canonical_texts():
    """The canonical texts are those of v7, byte for byte. In the design folder the texts are also compared with
    scripts/v8_common.py (the design scripts are not part of the public package)."""
    args = ("SYN-MU8-AREA-ONCOLOGY-801", "SYN-TRIAL-101", "SYN_FRAME", "AREA-ONCOLOGY", 7777, 6, "A", "ALLOW", 2026102408, "a" * 64)
    assert B.design_row_text(*args) == "SYN-MU8-AREA-ONCOLOGY-801|SYN-TRIAL-101|SYN_FRAME|AREA-ONCOLOGY|7777|6|A|ALLOW|2026102408|" + "a" * 64
    a2 = ("SYN8-ASSIGN-CANONICAL-TEST", "SYN-MU8-AREA-ONCOLOGY-801", "AREA_ONCOLOGY", "IN_AREA", "ASSIGNED")
    assert B.assignment_row_text(*a2) == "SYN8-ASSIGN-CANONICAL-TEST|SYN-MU8-AREA-ONCOLOGY-801|AREA_ONCOLOGY|IN_AREA|ASSIGNED"
    scripts = VAL.parents[1] / "scripts"
    if (scripts / "v8_common.py").exists():
        sys.path.insert(0, str(scripts))
        import v8_common as C  # noqa: E402
        assert B.design_row_text(*args) == C.design_row_text(*args)
        assert B.assignment_row_text(*a2) == C.assignment_row_text(*a2)
        assert PA.AREAS == C.AREA_CODES and PA.ROWS == C.ROWS and PA.SUBGROUPS == C.SUBGROUPS


def test_vocabulary_contract_lists_the_ten_areas():
    """Design folder layout (outputs/ beside code/) or repository layout (design_v8/ beside validation/)."""
    cands = [VAL / "fixtures" / "vocabulary.json", VAL.parents[1] / "outputs" / "VOCABULARY_CONTRACT_v8.json", VAL.parent / "design_v8" / "VOCABULARY_CONTRACT_v8.json"]
    p = next((c for c in cands if c.exists()), None)
    if p is None:
        pytest.skip("VOCABULARY_CONTRACT_v8.json not beside this code")
    v = json.loads(p.read_text(encoding="utf-8"))
    assert v["area_categories_in_cohort_rank_order"] == PA.AREAS
    assert sorted(k.split("|")[1] for k in v["mapping_labels"] if k.startswith("AREA|")) == sorted(PA.AREAS)


def test_allow_estimates_equal_an_independent_computation(tmp_path):
    b = make(tmp_path)
    rc, out = run(tmp_path, b, "--allow-synthetic")
    assert rc == 0
    fam = pd.read_csv(out / "family_estimates_v8.csv")
    for dom in ("AREA", "ROW"):
        for rule in ("R0", "R2"):
            r = fam[(fam.domain == dom) & (fam.rule == rule)].iloc[0]
            assert r.status == "ESTIMATED"
            assert r.estimate == pytest.approx(independent_hajek(b, dom, rule), abs=1e-12)
            assert r.ci_low <= r.estimate <= r.ci_high
            assert r.n_eff <= r.n_determinate + 1e-9
    rb = fam[(fam.domain == "ROW_BENCHMARKED") & (fam.rule == "R0")].iloc[0]
    assert rb.estimate == pytest.approx(independent_hajek(b, "ROW", "R0", categories=PA.BENCHMARKED_ROWS), abs=1e-12)


def test_no_estimate_or_percentage_pools_area_and_row_units(tmp_path):
    b = make(tmp_path)
    rc, out = run(tmp_path, b, "--allow-synthetic")
    fam = pd.read_csv(out / "family_estimates_v8.csv")
    assert set(fam.domain) == set(PA.FAMILY_DOMAINS)
    agr = pd.read_csv(out / "agreement_v8.csv")
    assert set(agr.domain) == {"AREA", "ROW", "SG"}
    assert "ALL" not in set(fam.domain) | set(agr.domain)


def test_area_estimate_does_not_move_when_a_row_answer_changes(tmp_path):
    """A row unit shares its trial with an area unit (ALLOW fixture); changing the row unit's final answer must leave the
    AREA estimate, interval and variance exactly as they were."""
    b = make(tmp_path)
    rc, out1 = run(tmp_path, b, "--allow-synthetic", name="before")
    R = pd.read_csv(b / "final_reference.csv", dtype=str, keep_default_na=False)
    i = R.index[R.unit_id == "SYN-MU8-ROW-COPD-801"][0]
    R.loc[i, "final_answer"] = "DISAGREE" if R.loc[i, "final_answer"] == "AGREE" else "AGREE"
    # Change the complete synthetic response history, not just the derived reference.
    answer = R.loc[i, "final_answer"]
    R.loc[i, "final_status"] = "CONCORDANT"
    R.loc[i, "routing"] = f"CONCORDANT_{answer}"
    for stage in ("initial", "effective"):
        for slot in (1, 2):
            R.loc[i, f"answer_{stage}_slot{slot}"] = answer
    for column in ("adjudication_reason_code", "adjudication_status", "adjudication_basis",
                   "adjudication_disagreement_reason_code"):
        R.loc[i, column] = ""
    J = pd.read_csv(b / "independent_judgments.csv", dtype=str, keep_default_na=False)
    which = J.unit_id.eq(R.loc[i, "unit_id"])
    for stage in ("initial", "effective"):
        J.loc[which, f"answer_{stage}"] = answer
        J.loc[which, f"reason_{stage}"] = "NOT_THE_CONDITION_STUDIED" if answer == "DISAGREE" else ""
    R.to_csv(b / "final_reference.csv", index=False, lineterminator="\n")
    J.to_csv(b / "independent_judgments.csv", index=False, lineterminator="\n")
    man = json.loads((b / "manifest.json").read_text())
    for name in ("final_reference.csv", "independent_judgments.csv"):
        man["files"][name] = B.sha256_file(b / name)
    (b / "manifest.json").write_text(json.dumps(man))
    rc, out2 = run(tmp_path, b, "--allow-synthetic", name="after")
    f1 = pd.read_csv(out1 / "family_estimates_v8.csv").set_index(["domain", "rule"])
    f2 = pd.read_csv(out2 / "family_estimates_v8.csv").set_index(["domain", "rule"])
    for rule in ("R0", "R2"):
        for col in ("estimate", "ci_low", "ci_high", "variance", "n_eff"):
            assert f1.loc[("AREA", rule), col] == f2.loc[("AREA", rule), col]
    assert f1.loc[("ROW", "R0"), "estimate"] != f2.loc[("ROW", "R0"), "estimate"]


def test_r2_counts_cannot_tell_and_unresolved_as_not_confirmed(tmp_path):
    b = make(tmp_path)
    rc, out = run(tmp_path, b, "--allow-synthetic")
    fam = pd.read_csv(out / "family_estimates_v8.csv").set_index(["domain", "rule"])
    R = pd.read_csv(b / "final_reference.csv", dtype=str, keep_default_na=False)
    for dom in ("AREA", "ROW"):
        g = R[R.family == dom]
        n_out = int(g.final_status.isin(["CANNOT_TELL_BY_RULE", "UNRESOLVED"]).sum())
        assert n_out >= 1
        assert fam.loc[(dom, "R2"), "n_determinate"] == fam.loc[(dom, "R0"), "n_determinate"] + n_out
        assert fam.loc[(dom, "R2"), "estimate"] <= fam.loc[(dom, "R0"), "estimate"]


def test_single_review_unit_is_excluded_and_counted(tmp_path):
    b = make(tmp_path)
    rc, out = run(tmp_path, b, "--allow-synthetic")
    fam = pd.read_csv(out / "family_estimates_v8.csv").set_index(["domain", "rule"])
    assert fam.loc[("AREA", "R2"), "n_units"] == 56 and fam.loc[("AREA", "R2"), "n_reviewed"] == 55
    cat = pd.read_csv(out / "category_counts_v8.csv").set_index("category")
    assert cat.loc["NEUROLOGICAL", "incomplete_single_review"] == 1


def test_ten_areas_with_the_v8_allocation(tmp_path):
    b = make(tmp_path)
    rc, out = run(tmp_path, b, "--allow-synthetic")
    cat = pd.read_csv(out / "category_counts_v8.csv")
    area = cat[cat.family == "AREA"].set_index("category")
    assert sorted(area.index) == sorted(PA.AREAS)
    assert sorted(area.n_h.tolist()) == [5, 5, 5, 5, 6, 6, 6, 6, 6, 6]
    assert int(area.n_h.sum()) == 56 and int(cat[cat.family == "ROW"].n_h.sum()) == 40


def test_trial_clustering_under_allow_stays_inside_a_family(tmp_path):
    b = make(tmp_path, "ALLOW")
    rc, out = run(tmp_path, b, "--allow-synthetic")
    fam = pd.read_csv(out / "family_estimates_v8.csv").set_index(["domain", "rule"])
    r = fam.loc[("AREA", "R0")]
    assert r.variance_basis in ("CLUSTER_ROBUST_BY_TRIAL", "STRATIFIED_NOT_BELOW_CLUSTER")
    assert r.n_eff <= r.n_trial_clusters
    # the trial shared by an area unit and a row unit does not create a cluster inside the ROW family
    assert pd.isna(fam.loc[("ROW", "R0"), "n_trial_clusters"]) and fam.loc[("ROW", "R0"), "variance_basis"] == "STRATIFIED"
    agr = pd.read_csv(out / "agreement_v8.csv").set_index(["answers", "domain"])
    assert agr.loc[("initial", "AREA"), "bootstrap_unit"] == "trial"
    assert agr.loc[("initial", "ROW"), "bootstrap_unit"] == "unit"


def test_one_per_trial_needs_and_uses_probabilities(tmp_path):
    b = make(tmp_path, "ONE_PER_TRIAL")
    rc, _ = run(tmp_path, b, "--allow-synthetic", name="no_probs")
    assert rc == 3
    rc, out = run(tmp_path, b, "--allow-synthetic", "--probabilities", str(b / "unit_probabilities.csv"), name="with_probs")
    assert rc == 0
    P = pd.read_csv(b / "unit_probabilities.csv")
    wts = dict(zip(P.unit_id, 1.0 / P.pi_mc_ONE_PER_TRIAL))
    fam = pd.read_csv(out / "family_estimates_v8.csv").set_index(["domain", "rule"])
    for dom in ("AREA", "ROW"):
        assert fam.loc[(dom, "R0"), "estimate"] == pytest.approx(independent_hajek(b, dom, "R0", weights=wts), abs=1e-12)
        assert pd.isna(fam.loc[(dom, "R0"), "n_trial_clusters"])


def test_subgroups_are_never_pooled(tmp_path):
    b = make(tmp_path)
    rc, out = run(tmp_path, b, "--allow-synthetic")
    fam = pd.read_csv(out / "family_estimates_v8.csv")
    assert "SG" not in set(fam.domain)
    sg = pd.read_csv(out / "subgroup_counts_v8.csv")
    assert sorted(sg.category) == sorted(PA.SUBGROUPS)
    assert set(sg.direction) == {"KEEP", "REMOVE"}
    assert (sg.reporting.str.startswith("counts only")).all()


def test_categories_report_counts_only(tmp_path):
    b = make(tmp_path)
    rc, out = run(tmp_path, b, "--allow-synthetic")
    cat = pd.read_csv(out / "category_counts_v8.csv")
    assert len(cat) == 20 and (cat.reporting.str.startswith("counts only")).all()


def test_agreement_by_family_initial_and_effective(tmp_path):
    b = make(tmp_path)
    rc, out = run(tmp_path, b, "--allow-synthetic")
    agr = pd.read_csv(out / "agreement_v8.csv").set_index(["answers", "domain"])
    assert sum(agr.loc[("initial", d), "n_pairs"] for d in ("AREA", "ROW", "SG")) == 99   # one unit answered once
    assert agr.loc[("initial", "AREA"), "n_pairs"] == 55
    assert agr.loc[("effective", "ROW"), "percent_agreement"] > agr.loc[("initial", "ROW"), "percent_agreement"]


def test_kappa_known_table():
    a = ["AGREE"] * 40 + ["DISAGREE"] * 10
    b = ["AGREE"] * 35 + ["DISAGREE"] * 5 + ["DISAGREE"] * 8 + ["AGREE"] * 2
    k = E.cohen_kappa(a, b, PA.ANSWERS)
    po = (35 + 8) / 50
    pe = (40 / 50) * (37 / 50) + (10 / 50) * (13 / 50)
    assert k["po"] == pytest.approx(po) and k["kappa"] == pytest.approx((po - pe) / (1 - pe))


def test_design_manifest_with_matching_allocation_is_accepted(tmp_path):
    b = make(tmp_path)
    dm = b.parent / f"{b.name}_design_manifest.json"
    rc, out = run(tmp_path, b, "--allow-synthetic", "--design-manifest", str(dm))
    assert rc == 0


@pytest.mark.parametrize("what", ["format", "tamper", "unitlist", "stratum", "synthetic", "manifest", "mode", "slot",
                                  "v7design", "unknown_category", "allocation", "overlap_setting"])
def test_refusals(tmp_path, what, capsys):
    b = make(tmp_path)
    extra = ["--allow-synthetic"]
    man = json.loads((b / "manifest.json").read_text())
    dm_path = b.parent / f"{b.name}_design_manifest.json"
    if what == "format":
        man["bundle_format_version"] = "6.0"
    elif what == "mode":
        man["mode"] = "PILOT"
    elif what == "v7design":
        man["design"]["design_version"] = "review-design-v7.0.0"
    elif what == "tamper":
        p = b / "final_reference.csv"
        p.write_text(p.read_text().replace(",CONCORDANT_DISAGREE,DISAGREE,", ",CONCORDANT_DISAGREE,AGREE,", 1) + "\n")
    elif what == "unitlist":
        man["freeze"]["unit_list_sha256"] = "0" * 64
    elif what == "stratum":
        D = pd.read_csv(b / "unit_design.csv", dtype=str, keep_default_na=False)
        D.loc[D.unit_id == "SYN-MU8-ROW-COPD-801", "n_sampled_in_stratum"] = "5"
        D.to_csv(b / "unit_design.csv", index=False, lineterminator="\n")
        man["files"]["unit_design.csv"] = B.sha256_file(b / "unit_design.csv")
    elif what == "synthetic":
        extra = []
    elif what == "manifest":
        dm = tmp_path / "design_manifest.json"
        dm.write_text(json.dumps({"unit_list_sha256": man["freeze"]["unit_list_sha256"], "assignment_set_sha256": "1" * 64,
                                  "design_rows_sha256": man["freeze"]["design_rows_sha256"]}))
        extra += ["--design-manifest", str(dm)]
    elif what in ("allocation", "overlap_setting"):
        dm = json.loads(dm_path.read_text())
        if what == "allocation":
            dm["strata"][0]["n_h"] = 5          # the design manifest says 5 units where the bundle has 6
        else:
            dm["overlap_setting"] = "ONE_PER_TRIAL"
        p = tmp_path / "dm_changed.json"
        p.write_text(json.dumps(dm))
        extra += ["--design-manifest", str(p)]
    elif what == "unknown_category":
        for f in ("units.csv", "final_reference.csv"):
            T = pd.read_csv(b / f, dtype=str, keep_default_na=False)
            T.loc[T.unit_id == "SYN-MU8-AREA-IMMUNE-801", "category"] = "IMMUNOLOGY"
            T.to_csv(b / f, index=False, lineterminator="\n")
            man["files"][f] = B.sha256_file(b / f)
    elif what == "slot":
        J = pd.read_csv(b / "independent_judgments.csv", dtype=str, keep_default_na=False)
        J = J[~((J.unit_id == "SYN-MU8-ROW-AST-801") & (J.reviewer_slot == "2"))]
        J.to_csv(b / "independent_judgments.csv", index=False, lineterminator="\n")
        man["files"]["independent_judgments.csv"] = B.sha256_file(b / "independent_judgments.csv")
    (b / "manifest.json").write_text(json.dumps(man))
    rc, out = run(tmp_path, b, *extra)
    assert rc == 3 and not out.exists()
    err = capsys.readouterr().err
    if what == "unknown_category":
        assert "AREA|IMMUNOLOGY" in err
    if what == "v7design":
        assert "performance_analysis_v7.py" in err


def test_stratum_n_mismatch_is_named_when_the_design_hash_is_kept(tmp_path, capsys):
    b = make(tmp_path)
    man = json.loads((b / "manifest.json").read_text())
    D = pd.read_csv(b / "unit_design.csv", dtype=str, keep_default_na=False)
    D.loc[D.stratum == "ROW-COPD", "n_sampled_in_stratum"] = "5"
    D["design_row_sha256"] = [B.sha256_text(B.design_row_text(*x)) for x in zip(D.unit_id, D.nct_id, D.frame_id, D.stratum,
                              D.frame_stratum_size, D.n_sampled_in_stratum, D.allocation_option, D.overlap_setting,
                              D.sampling_seed, D.prn_key)]
    D.to_csv(b / "unit_design.csv", index=False, lineterminator="\n")
    man["files"]["unit_design.csv"] = B.sha256_file(b / "unit_design.csv")
    man["freeze"]["design_rows_sha256"] = B.sha256_text("\n".join(D.sort_values("unit_id").design_row_sha256))
    (b / "manifest.json").write_text(json.dumps(man))
    rc, out = run(tmp_path, b, "--allow-synthetic")
    assert rc == 3 and "ROW-COPD" in capsys.readouterr().err


def test_outputs_use_the_agreed_wording(tmp_path):
    b = make(tmp_path)
    rc, out = run(tmp_path, b, "--allow-synthetic")
    txt = "".join(p.read_text() for p in out.iterdir() if p.suffix in (".md", ".csv"))
    low = txt.lower()
    for banned in ("ppv", "positive predictive", "upper bound", "accuracy", "sensitivity", "independent validation",
                   "validates", "\u2014", "\u2013"):
        assert banned not in low
    s = (out / "results_summary_v8.md").read_text()
    assert " to " in s and "clinician confirmation of displayed assignments" in s
    assert "never pooled" in s


def test_never_overwrites(tmp_path):
    b = make(tmp_path)
    rc, out = run(tmp_path, b, "--allow-synthetic")
    assert rc == 0
    assert PA.main(["--bundle", str(b), "--out", str(out), "--allow-synthetic"]) == 3


def _v7_db_bundle() -> Path | None:
    p = os.environ.get("MU7_DB_BUNDLE")
    if p and Path(p).exists():
        return Path(p)
    f = VAL / "fixtures" / "db_bundle_v7_synthetic"
    return f if f.exists() else None


def test_v7_database_written_bundle_is_refused(tmp_path, capsys):
    """The v7 synthetic bundle written by the app's v7 database suite is a design v7 bundle: v8 refuses it and names the
    v7 script, so a v7 bundle can never be read with the ten-area vocabulary."""
    b = _v7_db_bundle()
    if b is None:
        pytest.skip("validation/fixtures/db_bundle_v7_synthetic/ (from the v7 handoff) is not present")
    work = tmp_path / "v7b"
    shutil.copytree(b, work)
    rc, out = run(tmp_path, work, "--allow-synthetic")
    assert rc == 3 and not out.exists()
    assert "performance_analysis_v7.py" in capsys.readouterr().err


def _db_bundle() -> Path | None:
    p = os.environ.get("MU8_DB_BUNDLE")
    if p and Path(p).exists():
        return Path(p)
    f = VAL / "fixtures" / "db_bundle_v8_synthetic"
    return f if f.exists() else None


def test_database_written_bundle_end_to_end(tmp_path):
    """DB -> export -> analysis for design v8. The bundle comes from the application's database suite after the v8
    migrations (not available in the research workspace)."""
    b = _db_bundle()
    if b is None:
        if os.environ.get("MU8_ALLOW_NO_DB_BUNDLE") == "1":
            pytest.skip("no database-written v8 bundle (MU8_ALLOW_NO_DB_BUNDLE=1); produced by the application suite")
        pytest.fail("the database-written v8 bundle is missing: run the application's v8 database suite with a bundle folder")
    work = tmp_path / "dbb"
    shutil.copytree(b, work)
    probabilities = os.environ.get("MU8_DB_PROBABILITIES")
    extra = ["--probabilities", probabilities] if probabilities else []
    rc, out = run(tmp_path, work, "--allow-synthetic", *extra)
    assert rc == 0
    fam = pd.read_csv(out / "family_estimates_v8.csv")
    assert set(fam.domain) == set(PA.FAMILY_DOMAINS)
    units = pd.read_csv(work / "units.csv")
    judgments = pd.read_csv(work / "independent_judgments.csv")
    assert len(units) == 100 and len(judgments) == 200
    assert units.groupby("family").size().to_dict() == {"AREA": 56, "ROW": 40, "SG": 4}
    assert set(judgments.judgment_status) == {"ANSWERED"}
    # Planted outcomes in the database scenario, independently checked against the report.
    by_family = fam.set_index(["domain", "rule"])
    assert by_family.loc[("AREA", "R0"), "n_determinate"] == 54
    assert by_family.loc[("AREA", "R2"), "n_determinate"] == 56
    assert by_family.loc[("AREA", "R0"), "n_confirmed"] == 53
    assert by_family.loc[("ROW", "R0"), "n_determinate"] == 40
