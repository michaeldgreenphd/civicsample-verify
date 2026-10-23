#!/usr/bin/env python3
"""
validation/performance_analysis_v7.py  (review design v7: mapping-unit confirmation review)

Reads ONE export bundle in format 7.0 (written by the review app from the security_invoker export views of migration
NNNN_v7_mapping_units.sql), verifies it against its own manifest and against the frozen design, and writes the
prespecified analysis into a NEW folder. It never edits the bundle and never overwrites a file.

What it reports (REVIEW_RUBRIC_v7.md, EXPORT_TO_PERFORMANCE_SPEC_v7.md):
  Outcome: clinician confirmation of displayed assignments. Reviewers see our assignment, so the result is a
  confirmation share; it is not a positive predictive value, not an accuracy and not a proven bound on either, and it
  cannot detect mappings we missed (the review shows assigned mappings only).
  1. Families AREA (7 strata) and ROW (10 strata) pooled: Hajek ratio estimate with stratified linearization variance
     and the Wilson interval at n_eff (validation/mu7_estimators.py). ROW_BENCHMARKED (the 9 rows of the Figure 3
     model, Pain excluded) is a secondary domain (PROPOSED, gate G-EST-01).
     Rule R0 (primary): final CANNOT_TELL and unresolved units leave the denominator.
     Rule R2 (sensitivity): final CANNOT_TELL and unresolved units count as not confirmed.
     A unit answered by one reviewer only has no final reference (INCOMPLETE) and leaves both rules (PROPOSED, G-EST-01).
  2. Every category (stratum): counts only (no stratum holds 10 determinate units under Option A).
  3. The four subgroup strata (rule D kept, rule D removed, rule K kept, rule K removed): counts only, KEEP and REMOVE
     reported separately, never pooled.
  4. Agreement of the two reviewers on the INITIAL answers (the 100 pairs) and on the effective answers: percent
     agreement and Cohen's kappa over AGREE, DISAGREE and CANNOT_TELL, with a percentile bootstrap interval.
  5. Routing, final status, reason codes and uncertainty flags.
Overlap setting (gate G-OVERLAP-01, read from the design rows): ALLOW uses the stratified weights N_h / n_h and, when a
trial holds two or more units of one family, the larger of the stratified and the trial-cluster variance, with n_eff
capped at the number of trials (PROPOSED, G-EST-01); bootstrap resamples trials. ONE_PER_TRIAL needs the Monte Carlo
inclusion probabilities (--probabilities, from scripts/04_overlap_alternative_mc_v7.py) and uses weights 1 / pi without
the finite population correction.

Refusals (exit code 3, message starts with REFUSED): a format other than 7.0; a file whose SHA-256 differs from the
manifest; a unit list, assignment set or design-row hash that differs from the freeze (or from --design-manifest); a
stratum whose number of units differs from its design n; a missing slot or unit; mode other than FORMAL; a synthetic
bundle without --allow-synthetic; ONE_PER_TRIAL without probabilities for every unit.

Usage (Maryam Aziz or Michael Green; Python 3.10 or later with pandas and numpy):
  python performance_analysis_v7.py --bundle BUNDLE_DIR --out NEW_DIR [--design-manifest freeze_manifest_v7.json]
         [--probabilities UNIT_PROBABILITIES.csv] [--bootstrap-reps 2000] [--seed 2026102307] [--allow-synthetic]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mu7_bundle as B  # noqa: E402
import mu7_estimators as E  # noqa: E402

FORMAT = "7.0"
ANSWERS = ["AGREE", "DISAGREE", "CANNOT_TELL"]
BENCHMARKED_ROWS = ["CAN_ALL", "DIAB", "DEP", "OBE", "AST", "COPD", "COV", "SCZ", "HTN"]
SUBGROUPS = ["RULE_D_KEPT", "RULE_D_REMOVED", "RULE_K_KEPT", "RULE_K_REMOVED"]
SG_PARENT = {"RULE_D_KEPT": "Diabetes Mellitus", "RULE_D_REMOVED": "Diabetes Mellitus", "RULE_K_KEPT": "Neoplasms",
             "RULE_K_REMOVED": "Neoplasms"}
REVIEWED_STATUSES = {"CONCORDANT", "ADJUDICATED", "CANNOT_TELL_BY_RULE", "UNRESOLVED"}
FILES = ["units.csv", "unit_design.csv", "independent_judgments.csv", "final_reference.csv"]


class Refused(Exception):
    pass


def refuse_unless(cond: bool, msg: str) -> None:
    if not cond:
        raise Refused(msg)


# ---------------------------------------------------------------------------------------------------------------------
# 1. Load and verify
# ---------------------------------------------------------------------------------------------------------------------
def load_bundle(d: Path, allow_synthetic: bool, design_manifest: Path | None) -> dict:
    refuse_unless((d / "manifest.json").exists(), f"no manifest.json in {d}")
    man = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
    refuse_unless(str(man.get("bundle_format_version")) == FORMAT, f"bundle format {man.get('bundle_format_version')!r}, expected {FORMAT}")
    refuse_unless(man.get("mode") == "FORMAL", f"mode {man.get('mode')!r}: only a FORMAL bundle is analysed")
    synthetic = str(man.get("status", "")).upper().startswith("SYNTHETIC")
    refuse_unless(allow_synthetic or not synthetic, "a SYNTHETIC bundle needs --allow-synthetic")
    for f in FILES:
        refuse_unless((d / f).exists(), f"missing {f}")
        refuse_unless(B.sha256_file(d / f) == man["files"].get(f), f"{f}: SHA-256 differs from the manifest")
    T = {f: pd.read_csv(d / f, dtype=str, keep_default_na=False) for f in FILES}
    U, D, J, R = (T[f] for f in FILES)
    fz = man["freeze"]
    refuse_unless(B.unit_list_sha256(U.unit_id) == fz["unit_list_sha256"], "unit list hash differs from the freeze")
    D = D.set_index("unit_id", drop=False)
    drt = {u: B.design_row_text(u, D.at[u, "nct_id"], D.at[u, "frame_id"], D.at[u, "stratum"], int(D.at[u, "frame_stratum_size"]),
                                int(D.at[u, "n_sampled_in_stratum"]), D.at[u, "allocation_option"], D.at[u, "overlap_setting"],
                                int(D.at[u, "sampling_seed"]), D.at[u, "prn_key"]) for u in D.index}
    refuse_unless(B.set_sha256(drt) == fz["design_rows_sha256"], "design-row hash differs from the freeze")
    Ui = U.set_index("unit_id", drop=False)
    art = {u: B.assignment_row_text(D.at[u, "assignment_set_id"], u, Ui.at[u, "mapping_code"], Ui.at[u, "assignment_code"],
                                    Ui.at[u, "assignment_status"]) for u in Ui.index}
    refuse_unless(B.set_sha256(art) == fz["assignment_set_sha256"], "assignment-set hash differs from the freeze")
    if design_manifest is not None:
        dm = json.loads(design_manifest.read_text(encoding="utf-8"))
        for k in ("unit_list_sha256", "assignment_set_sha256", "design_rows_sha256"):
            refuse_unless(dm.get(k) == fz.get(k), f"{k} differs between the bundle freeze and the design manifest")
    refuse_unless(set(U.unit_id) == set(D.index) == set(R.unit_id), "units, design rows and final reference cover different units")
    slots = J.groupby("unit_id").reviewer_slot.apply(lambda s: sorted(s.astype(int)))
    refuse_unless(all(slots.get(u, []) == [1, 2] for u in U.unit_id), "every unit needs one row per reviewer slot (1 and 2)")
    cnt = D.groupby("stratum").unit_id.size()
    nh = D.groupby("stratum").n_sampled_in_stratum.first().astype(int)
    bad = [s for s in cnt.index if cnt[s] != nh[s]]
    refuse_unless(not bad, f"strata whose number of units differs from their design n: {bad}")
    ov = sorted(set(D.overlap_setting))
    refuse_unless(len(ov) == 1 and ov[0] in ("ALLOW", "ONE_PER_TRIAL"), f"one overlap setting expected, found {ov}")
    return {"manifest": man, "units": U, "design": D, "judgments": J, "final": R, "overlap": ov[0], "synthetic": synthetic}


# ---------------------------------------------------------------------------------------------------------------------
# 2. Analysis frame
# ---------------------------------------------------------------------------------------------------------------------
def analysis_frame(b: dict, probabilities: Path | None) -> pd.DataFrame:
    D, R = b["design"], b["final"].set_index("unit_id")
    X = pd.DataFrame({"unit_id": D.index})
    X["family"] = X.unit_id.map(R.family)
    X["category"] = X.unit_id.map(R.category)
    X["stratum"] = X.unit_id.map(D.stratum)
    X["N_h"] = X.unit_id.map(D.frame_stratum_size).astype(float)
    X["n_h"] = X.unit_id.map(D.n_sampled_in_stratum).astype(int)
    X["nct_id"] = X.unit_id.map(D.nct_id)
    X["final_answer"] = X.unit_id.map(R.final_answer)
    X["final_status"] = X.unit_id.map(R.final_status)
    X["routing"] = X.unit_id.map(R.routing)
    X["reviewed"] = X.final_status.isin(REVIEWED_STATUSES)
    X["y"] = (X.final_answer == "AGREE").astype(int)
    X["d_R0"] = X.final_answer.isin(["AGREE", "DISAGREE"]).astype(int)
    X["d_R2"] = X.reviewed.astype(int)
    if b["overlap"] == "ONE_PER_TRIAL":
        refuse_unless(probabilities is not None, "overlap ONE_PER_TRIAL needs --probabilities (Monte Carlo inclusion probabilities)")
        P = pd.read_csv(probabilities, dtype={"unit_id": str})
        col = "pi_mc_ONE_PER_TRIAL" if "pi_mc_ONE_PER_TRIAL" in P.columns else "pi"
        pm = dict(zip(P.unit_id, P[col].astype(float)))
        refuse_unless(all(u in pm and pm[u] > 0 for u in X.unit_id), "a unit has no Monte Carlo inclusion probability")
        X["w"] = X.unit_id.map(lambda u: 1.0 / pm[u])
    return X


# ---------------------------------------------------------------------------------------------------------------------
# 3. Estimates and summaries
# ---------------------------------------------------------------------------------------------------------------------
def family_estimates(X: pd.DataFrame, overlap: str) -> pd.DataFrame:
    rows = []
    domains = {"AREA": X.family == "AREA", "ROW": X.family == "ROW",
               "ROW_BENCHMARKED": (X.family == "ROW") & X.category.isin(BENCHMARKED_ROWS)}
    for name, dom in domains.items():
        for rule in ("R0", "R2"):
            df = X.assign(in_domain=dom, d=X[f"d_{rule}"])
            if overlap == "ONE_PER_TRIAL":
                r = E.stratified_ratio(df, weight_col="w", fpc=False)
            else:
                r = E.stratified_ratio(df, cluster_col="nct_id")
            rows.append({"domain": name, "rule": rule,
                         "role": "secondary (PROPOSED, gate G-EST-01)" if name == "ROW_BENCHMARKED" else "primary family",
                         "overlap_setting": overlap, **{k: r.get(k) for k in (
                             "n_units", "n_reviewed", "n_determinate", "n_confirmed", "n_not_confirmed", "estimate",
                             "ci_low", "ci_high", "n_eff", "n_eff_kish", "n_eff_variance", "variance", "variance_basis",
                             "n_trial_clusters", "status")}})
    return pd.DataFrame(rows)


def category_counts(X: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for (fam, cat), g in X.groupby(["family", "category"], sort=False):
        rows.append({"family": fam, "category": cat, "stratum": g.stratum.iloc[0], "N_h": int(g.N_h.iloc[0]),
                     "n_h": int(g.n_h.iloc[0]), "units": len(g),
                     "final_AGREE": int((g.final_answer == "AGREE").sum()),
                     "final_DISAGREE": int((g.final_answer == "DISAGREE").sum()),
                     "final_CANNOT_TELL": int((g.final_status == "CANNOT_TELL_BY_RULE").sum()),
                     "unresolved": int((g.final_status == "UNRESOLVED").sum()),
                     "incomplete_single_review": int((g.final_status == "INCOMPLETE").sum()),
                     "reporting": ("counts only (fewer than 10 determinate units)"
                                   if g.d_R0.sum() < E.NOT_ESTIMABLE_BELOW else "share reportable"),
                     "parent_row": SG_PARENT.get(cat, ""),
                     "direction": ("KEEP" if cat.endswith("_KEPT") else "REMOVE") if fam == "SG" else ""})
    return pd.DataFrame(rows)


def agreement(b: dict, X: pd.DataFrame, reps: int, seed: int, overlap: str) -> pd.DataFrame:
    J = b["judgments"]
    wide = J.pivot(index="unit_id", columns="reviewer_slot", values=["answer_initial", "answer_effective"])
    fam = X.set_index("unit_id").family
    trial = X.set_index("unit_id").nct_id
    rows = []
    for which in ("answer_initial", "answer_effective"):
        w = wide[which].rename(columns=lambda c: int(c))
        both = w[(w[1].isin(ANSWERS)) & (w[2].isin(ANSWERS))]
        for name, idx in (("ALL", both.index), ("AREA", both.index[fam[both.index] == "AREA"]),
                          ("ROW", both.index[fam[both.index] == "ROW"]), ("SG", both.index[fam[both.index] == "SG"])):
            a, c = list(both.loc[idx, 1]), list(both.loc[idx, 2])
            k = E.cohen_kappa(a, c, ANSWERS)
            lo = hi = None
            if k["n"] >= 2 and k["kappa"] is not None:
                repeated = trial[idx].duplicated().any()
                if overlap == "ALLOW" and repeated:
                    lo, hi = cluster_bootstrap_kappa(a, c, list(trial[idx]), reps, seed)
                else:
                    lo, hi = E.kappa_bootstrap_ci(a, c, ANSWERS, reps=reps, seed=seed)
            rows.append({"answers": "initial" if which == "answer_initial" else "effective", "domain": name,
                         "n_pairs": k["n"], "percent_agreement": k["po"], "expected_agreement": k["pe"],
                         "kappa": k["kappa"], "kappa_ci_low": lo, "kappa_ci_high": hi, "bootstrap_reps": reps,
                         "bootstrap_seed": seed,
                         "bootstrap_unit": "trial" if (overlap == "ALLOW" and trial[idx].duplicated().any()) else "unit"})
    return pd.DataFrame(rows)


def cluster_bootstrap_kappa(a, c, clusters, reps: int, seed: int):
    rng = np.random.default_rng(seed)
    df = pd.DataFrame({"a": a, "c": c, "k": clusters})
    ids = df.k.unique()
    groups = {k: g for k, g in df.groupby("k")}
    ks = []
    for _ in range(reps):
        pick = rng.choice(ids, size=len(ids), replace=True)
        s = pd.concat([groups[k] for k in pick])
        v = E.cohen_kappa(list(s.a), list(s.c), ANSWERS)["kappa"]
        if v is not None:
            ks.append(v)
    return (float(np.percentile(ks, 2.5)), float(np.percentile(ks, 97.5))) if ks else (None, None)


def reason_counts(b: dict, X: pd.DataFrame) -> pd.DataFrame:
    J = b["judgments"].copy()
    J["family"] = J.unit_id.map(X.set_index("unit_id").family)
    rows = []
    for which, col in (("initial", "reason_initial"), ("effective", "reason_effective")):
        g = J[J[col] != ""].groupby(["family", col]).size()
        for (fam, rc), n in g.items():
            rows.append({"answers": which, "source": "reviewers", "family": fam, "reason_code": rc, "count": int(n)})
    R = b["final"]
    g = R[R.adjudication_reason_code != ""].groupby(["family", "adjudication_reason_code"]).size()
    for (fam, rc), n in g.items():
        rows.append({"answers": "adjudicated", "source": "adjudicator", "family": fam, "reason_code": rc, "count": int(n)})
    return pd.DataFrame(rows, columns=["answers", "source", "family", "reason_code", "count"])


def routing_summary(b: dict) -> pd.DataFrame:
    R = b["final"]
    g = R.groupby(["family", "routing", "final_status"]).size().reset_index(name="units")
    return g


def uncertainty_summary(b: dict) -> pd.DataFrame:
    J = b["judgments"]
    J = J[J.judgment_status == "ANSWERED"]
    g = J.groupby(["answer_initial", "uncertain_initial"]).size().reset_index(name="judgments")
    return g


def fmt_ci(est, lo, hi) -> str:
    if est is None or (isinstance(est, float) and math.isnan(est)):
        return "not estimable"
    if lo is None:
        return f"{100 * est:.1f}% (no interval)"
    return f"{100 * est:.1f}% (95% CI {100 * lo:.1f}% to {100 * hi:.1f}%)"


# ---------------------------------------------------------------------------------------------------------------------
# 4. Main
# ---------------------------------------------------------------------------------------------------------------------
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--bundle", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--design-manifest", type=Path)
    ap.add_argument("--probabilities", type=Path)
    ap.add_argument("--bootstrap-reps", type=int, default=2000)
    ap.add_argument("--seed", type=int, default=2026102307)
    ap.add_argument("--allow-synthetic", action="store_true")
    a = ap.parse_args(argv)
    if a.out.exists():
        print(f"REFUSED: {a.out} exists; the analysis writes to a new folder", file=sys.stderr)
        return 3
    try:
        b = load_bundle(a.bundle, a.allow_synthetic, a.design_manifest)
        X = analysis_frame(b, a.probabilities)
    except Refused as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        return 3
    fam = family_estimates(X, b["overlap"])
    cat = category_counts(X)
    agr = agreement(b, X, a.bootstrap_reps, a.seed, b["overlap"])
    rea = reason_counts(b, X)
    rou = routing_summary(b)
    unc = uncertainty_summary(b)
    a.out.mkdir(parents=True)
    out = {"family_estimates_v7.csv": fam, "category_counts_v7.csv": cat[cat.family != "SG"],
           "subgroup_counts_v7.csv": cat[cat.family == "SG"], "agreement_v7.csv": agr, "reason_codes_v7.csv": rea,
           "routing_summary_v7.csv": rou, "uncertainty_flags_v7.csv": unc}
    for name, df in out.items():
        df.to_csv(a.out / name, index=False, lineterminator="\n")
    trace = []
    for r in fam.itertuples():
        trace.append({"quantity": f"{r.domain} {r.rule} clinician confirmation share", "value": r.estimate,
                      "text": fmt_ci(r.estimate, r.ci_low, r.ci_high), "source": "family_estimates_v7.csv",
                      "method": f"Hajek ratio, Wilson at n_eff; {r.status}"})
    for r in agr[agr.domain == "ALL"].itertuples():
        trace.append({"quantity": f"kappa, {r.answers} answers, all units", "value": r.kappa,
                      "text": "" if r.kappa is None else f"{r.kappa:.2f} (95% CI {r.kappa_ci_low:.2f} to {r.kappa_ci_high:.2f}), n = {r.n_pairs} pairs",
                      "source": "agreement_v7.csv", "method": "Cohen's kappa, percentile bootstrap"})
    pd.DataFrame(trace).to_csv(a.out / "numbers_trace_analysis_v7.csv", index=False, lineterminator="\n")
    lines = ["# Mapping-unit confirmation review: results (bundle 7.0)", "",
             f"Bundle: {a.bundle} (overlap setting {b['overlap']}{'; SYNTHETIC' if b['synthetic'] else ''}).",
             "Outcome: clinician confirmation of displayed assignments. Reviewers saw our assignment; the share is not a "
             "measure of missed mappings.", ""]
    for r in fam.itertuples():
        lines.append(f"- {r.domain}, rule {r.rule}: {fmt_ci(r.estimate, r.ci_low, r.ci_high)}; {r.n_confirmed} of "
                     f"{r.n_determinate} units in the denominator confirmed ({r.status}).")
    lines += ["", "Subgroup strata (counts only, never pooled):"]
    for r in cat[cat.family == "SG"].itertuples():
        lines.append(f"- {r.category} ({r.direction}, {r.parent_row} row): {r.final_AGREE} AGREE, {r.final_DISAGREE} "
                     f"DISAGREE, {r.final_CANNOT_TELL} CANNOT_TELL, {r.unresolved} unresolved, {r.incomplete_single_review} "
                     "single review.")
    txt = "\n".join(lines) + "\n"
    (a.out / "results_summary_v7.md").write_text(txt, encoding="utf-8")
    log = {"script": "performance_analysis_v7.py", "run_at_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "bundle": str(a.bundle), "bundle_manifest_sha256": B.sha256_file(a.bundle / "manifest.json"),
           "overlap_setting": b["overlap"], "synthetic": b["synthetic"], "n_units": int(len(X)),
           "bootstrap_reps": a.bootstrap_reps, "seed": a.seed,
           "outputs": {p.name: B.sha256_file(p) for p in sorted(a.out.iterdir())}}
    (a.out / "run_log_v7.json").write_text(json.dumps(log, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"units": len(X), "overlap": b["overlap"], "families": fam[["domain", "rule", "status"]].to_dict("records")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
