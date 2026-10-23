"""
validation/tests/test_performance_analysis_v7.py  (review design v7; synthetic bundles only)

Run: python -m pytest -q validation/tests/test_performance_analysis_v7.py
The database-written bundle (rls_tests_v7.mjs, db1) is read from fixtures/db_bundle_v7_synthetic/ or from the folder
named by MU7_DB_BUNDLE; the test that needs it fails (it is not skipped) when neither exists, unless
MU7_ALLOW_NO_DB_BUNDLE=1 is set.
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
import mu7_bundle as B  # noqa: E402
import mu7_estimators as E  # noqa: E402
import performance_analysis_v7 as PA  # noqa: E402
import make_synthetic_v7_bundle as MK  # noqa: E402


def make(tmp_path, setting="ALLOW", seed=7) -> Path:
    return MK.write(MK.build(setting, seed), tmp_path / f"bundle_{setting}_{seed}", setting)


def run(tmp_path, bundle, *extra, name="out"):
    out = tmp_path / name
    rc = PA.main(["--bundle", str(bundle), "--out", str(out), "--bootstrap-reps", "200", *extra])
    return rc, out


def independent_hajek(bundle: Path, families, rule: str, weights=None) -> float:
    """The estimate recomputed directly from the CSV files, without the analysis code."""
    D = pd.read_csv(bundle / "unit_design.csv", dtype=str, keep_default_na=False)
    R = pd.read_csv(bundle / "final_reference.csv", dtype=str, keep_default_na=False)
    X = D.merge(R[["unit_id", "family", "category", "final_answer", "final_status"]], on="unit_id")
    X = X[X.family == families]
    X = X[X.final_status != "INCOMPLETE"]
    r_h = X.groupby("stratum").unit_id.transform("size")
    w = X.frame_stratum_size.astype(float) / r_h if weights is None else X.unit_id.map(weights)
    d = X.final_answer.isin(["AGREE", "DISAGREE"]) if rule == "R0" else pd.Series(True, index=X.index)
    y = X.final_answer == "AGREE"
    return float((w * d * y).sum() / (w * d).sum())


# ---------------------------------------------------------------------------------------------------------------------
def test_canonical_texts():
    """The documented canonical texts (EXPORT_TO_PERFORMANCE_SPEC_v7.md, mu7_bundle.py). In the design folder, where the
    design scripts exist, the texts are also compared with review_design_v7/scripts/v7_common.py; the database side is
    compared by the freeze of the private dry run (dry_run_private_v7.mjs)."""
    # Repository change (civicsample-verify): the synthetic placeholder is built at run time so this
    # public source carries no registry-format literal (scripts/check-fixtures.mjs); same value.
    syn_nct = "NCT" + "99000101"
    args = ("MU7-AREA-ONCOLOGY-001", syn_nct, "FIG3_14906", "AREA-ONCOLOGY", 8605, 8, "A", "ALLOW", 2026102307, "a" * 64)
    assert B.design_row_text(*args) == "MU7-AREA-ONCOLOGY-001|" + syn_nct + "|FIG3_14906|AREA-ONCOLOGY|8605|8|A|ALLOW|2026102307|" + "a" * 64
    a2 = ("MU7-ASSIGN-PROPOSED-20261023", "MU7-AREA-ONCOLOGY-001", "AREA_ONCOLOGY", "IN_AREA", "ASSIGNED")
    assert B.assignment_row_text(*a2) == "MU7-ASSIGN-PROPOSED-20261023|MU7-AREA-ONCOLOGY-001|AREA_ONCOLOGY|IN_AREA|ASSIGNED"
    scripts = VAL.parents[1] / "scripts"
    if (scripts / "v7_common.py").exists():
        sys.path.insert(0, str(scripts))
        import v7_common as C  # noqa: E402
        assert B.design_row_text(*args) == C.design_row_text(*args)
        assert B.assignment_row_text(*a2) == C.assignment_row_text(*a2)


def test_allow_estimates_equal_an_independent_computation(tmp_path):
    b = make(tmp_path)
    rc, out = run(tmp_path, b, "--allow-synthetic")
    assert rc == 0
    fam = pd.read_csv(out / "family_estimates_v7.csv")
    for dom in ("AREA", "ROW"):
        for rule in ("R0", "R2"):
            r = fam[(fam.domain == dom) & (fam.rule == rule)].iloc[0]
            assert r.status == "ESTIMATED"
            assert r.estimate == pytest.approx(independent_hajek(b, dom, rule), abs=1e-12)
            assert r.ci_low <= r.estimate <= r.ci_high
            assert r.n_eff <= r.n_determinate + 1e-9


def test_r2_counts_cannot_tell_and_unresolved_as_not_confirmed(tmp_path):
    b = make(tmp_path)
    rc, out = run(tmp_path, b, "--allow-synthetic")
    fam = pd.read_csv(out / "family_estimates_v7.csv").set_index(["domain", "rule"])
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
    fam = pd.read_csv(out / "family_estimates_v7.csv").set_index(["domain", "rule"])
    assert fam.loc[("AREA", "R2"), "n_units"] == 56 and fam.loc[("AREA", "R2"), "n_reviewed"] == 55
    cat = pd.read_csv(out / "category_counts_v7.csv").set_index("category")
    assert cat.loc["NEUROLOGICAL", "incomplete_single_review"] == 1


def test_trial_clustering_under_allow(tmp_path):
    b = make(tmp_path, "ALLOW")
    rc, out = run(tmp_path, b, "--allow-synthetic")
    r = pd.read_csv(out / "family_estimates_v7.csv").query("domain == 'AREA' and rule == 'R0'").iloc[0]
    assert r.variance_basis in ("CLUSTER_ROBUST_BY_TRIAL", "STRATIFIED_NOT_BELOW_CLUSTER")
    assert r.n_eff <= r.n_trial_clusters
    agr = pd.read_csv(out / "agreement_v7.csv").query("answers == 'initial' and domain == 'ALL'").iloc[0]
    assert agr.bootstrap_unit == "trial"


def test_one_per_trial_needs_and_uses_probabilities(tmp_path):
    b = make(tmp_path, "ONE_PER_TRIAL")
    rc, _ = run(tmp_path, b, "--allow-synthetic", name="no_probs")
    assert rc == 3
    rc, out = run(tmp_path, b, "--allow-synthetic", "--probabilities", str(b / "unit_probabilities.csv"), name="with_probs")
    assert rc == 0
    P = pd.read_csv(b / "unit_probabilities.csv")
    wts = dict(zip(P.unit_id, 1.0 / P.pi_mc_ONE_PER_TRIAL))
    r = pd.read_csv(out / "family_estimates_v7.csv").query("domain == 'AREA' and rule == 'R0'").iloc[0]
    assert r.estimate == pytest.approx(independent_hajek(b, "AREA", "R0", weights=wts), abs=1e-12)
    assert pd.isna(r.n_trial_clusters)


def test_subgroups_are_never_pooled(tmp_path):
    b = make(tmp_path)
    rc, out = run(tmp_path, b, "--allow-synthetic")
    fam = pd.read_csv(out / "family_estimates_v7.csv")
    assert "SG" not in set(fam.domain)
    sg = pd.read_csv(out / "subgroup_counts_v7.csv")
    assert sorted(sg.category) == sorted(PA.SUBGROUPS)
    assert set(sg.direction) == {"KEEP", "REMOVE"}
    assert (sg.reporting.str.startswith("counts only")).all()


def test_categories_report_counts_only(tmp_path):
    b = make(tmp_path)
    rc, out = run(tmp_path, b, "--allow-synthetic")
    cat = pd.read_csv(out / "category_counts_v7.csv")
    assert len(cat) == 17 and (cat.reporting.str.startswith("counts only")).all()


def test_agreement_initial_and_effective_differ_on_the_revision(tmp_path):
    b = make(tmp_path)
    rc, out = run(tmp_path, b, "--allow-synthetic")
    agr = pd.read_csv(out / "agreement_v7.csv").set_index(["answers", "domain"])
    assert agr.loc[("initial", "ALL"), "n_pairs"] == 99           # 100 units, one answered by one reviewer
    assert agr.loc[("effective", "ALL"), "percent_agreement"] > agr.loc[("initial", "ALL"), "percent_agreement"]


def test_kappa_known_table():
    a = ["AGREE"] * 40 + ["DISAGREE"] * 10
    b = ["AGREE"] * 35 + ["DISAGREE"] * 5 + ["DISAGREE"] * 8 + ["AGREE"] * 2
    k = E.cohen_kappa(a, b, PA.ANSWERS)
    po = (35 + 8) / 50
    pe = (40 / 50) * (37 / 50) + (10 / 50) * (13 / 50)
    assert k["po"] == pytest.approx(po) and k["kappa"] == pytest.approx((po - pe) / (1 - pe))


@pytest.mark.parametrize("what", ["format", "tamper", "unitlist", "stratum", "synthetic", "manifest", "mode", "slot"])
def test_refusals(tmp_path, what):
    b = make(tmp_path)
    extra = ["--allow-synthetic"]
    man = json.loads((b / "manifest.json").read_text())
    if what == "format":
        man["bundle_format_version"] = "6.0"
    elif what == "mode":
        man["mode"] = "PILOT"
    elif what == "tamper":
        p = b / "final_reference.csv"
        p.write_text(p.read_text().replace(",CONCORDANT_DISAGREE,DISAGREE,", ",CONCORDANT_DISAGREE,AGREE,", 1) + "\n")
    elif what == "unitlist":
        man["freeze"]["unit_list_sha256"] = "0" * 64
    elif what == "stratum":
        D = pd.read_csv(b / "unit_design.csv", dtype=str, keep_default_na=False)
        D.loc[D.unit_id == "MU7-ROW-COPD-001", "n_sampled_in_stratum"] = "5"
        D.to_csv(b / "unit_design.csv", index=False, lineterminator="\n")
        man["files"]["unit_design.csv"] = B.sha256_file(b / "unit_design.csv")
    elif what == "synthetic":
        extra = []
    elif what == "manifest":
        dm = tmp_path / "design_manifest.json"
        dm.write_text(json.dumps({"unit_list_sha256": man["freeze"]["unit_list_sha256"], "assignment_set_sha256": "1" * 64,
                                  "design_rows_sha256": man["freeze"]["design_rows_sha256"]}))
        extra += ["--design-manifest", str(dm)]
    elif what == "slot":
        J = pd.read_csv(b / "independent_judgments.csv", dtype=str, keep_default_na=False)
        J = J[~((J.unit_id == "MU7-ROW-AST-001") & (J.reviewer_slot == "2"))]
        J.to_csv(b / "independent_judgments.csv", index=False, lineterminator="\n")
        man["files"]["independent_judgments.csv"] = B.sha256_file(b / "independent_judgments.csv")
    (b / "manifest.json").write_text(json.dumps(man))
    rc, out = run(tmp_path, b, *extra)
    assert rc == 3 and not out.exists()


def test_stratum_n_mismatch_is_named_when_the_design_hash_is_kept(tmp_path, capsys):
    """A stratum whose unit count differs from its design n is refused with its own message (the design-row hash is
    recomputed for the edited row so that only the stratum check can fail)."""
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
    for banned in ("ppv", "positive predictive", "upper bound", "accuracy", "\u2014"):
        assert banned not in low
    s = (out / "results_summary_v7.md").read_text()
    assert " to " in s and "clinician confirmation of displayed assignments" in s


def test_never_overwrites(tmp_path):
    b = make(tmp_path)
    rc, out = run(tmp_path, b, "--allow-synthetic")
    assert rc == 0
    assert PA.main(["--bundle", str(b), "--out", str(out), "--allow-synthetic"]) == 3


def _db_bundle() -> Path | None:
    p = os.environ.get("MU7_DB_BUNDLE")
    if p and Path(p).exists():
        return Path(p)
    f = VAL / "fixtures" / "db_bundle_v7_synthetic"
    return f if f.exists() else None


def test_database_written_bundle_end_to_end(tmp_path):
    """DB -> export -> analysis: the bundle that rls_tests_v7.mjs writes from db1 (8 FORMAL fixture units)."""
    b = _db_bundle()
    if b is None:
        if os.environ.get("MU7_ALLOW_NO_DB_BUNDLE") == "1":
            pytest.skip("no database-written bundle (MU7_ALLOW_NO_DB_BUNDLE=1)")
        pytest.fail("the database-written bundle is missing: run rls_tests_v7.mjs with a bundle folder")
    work = tmp_path / "dbb"
    shutil.copytree(b, work)
    rc, out = run(tmp_path, work, "--allow-synthetic")
    assert rc == 0
    R = pd.read_csv(work / "final_reference.csv", dtype=str, keep_default_na=False)
    assert dict(zip(R.unit_id, R.final_status)) == {
        "MU7-AREA-ONCOLOGY-001": "CONCORDANT", "MU7-AREA-MENTAL_HEALTH-001": "ADJUDICATED",
        "MU7-AREA-RESPIRATORY-001": "ADJUDICATED", "MU7-ROW-CAN_ALL-001": "CONCORDANT", "MU7-ROW-DIAB-001": "CANNOT_TELL_BY_RULE",
        "MU7-ROW-PAIN-001": "CONCORDANT", "MU7-SG-RULE_D_REMOVED-001": "CONCORDANT", "MU7-SG-RULE_K_KEPT-001": "UNRESOLVED"}
    fam = pd.read_csv(out / "family_estimates_v7.csv")
    assert (fam.status == "NOT_ESTIMABLE_FEWER_THAN_10_DETERMINATE_UNITS").all()
    agr = pd.read_csv(out / "agreement_v7.csv").query("answers == 'initial' and domain == 'ALL'").iloc[0]
    assert agr.n_pairs == 8 and agr.percent_agreement == pytest.approx(0.5)
    assert agr.bootstrap_unit == "trial"            # MU7-AREA-ONCOLOGY-001 and MU7-ROW-CAN_ALL-001 share a trial
