#!/usr/bin/env python3
"""
validation/performance_analysis_v8.py  (review design v8: mapping-unit confirmation review over the ten areas)

Reads ONE export bundle in format 7.0 (the app's export views are unchanged by design v8; only the category vocabulary
grows), verifies it against its own manifest and against the frozen design, and writes the proposed analysis into a
NEW folder. It never edits the bundle and never overwrites a file. Adapted from the v8 handoff.
This repository integration is SYNTHETIC ONLY pending approved methods and database export verification.

What it reports (REVIEW_RUBRIC_v8_PROPOSED.md, EXPORT_TO_PERFORMANCE_SPEC_v8_PROPOSED.md):
  Outcome: clinician confirmation of displayed assignments. Reviewers see our assignment, so the result is a
  confirmation share. It is not an accuracy, not a sensitivity (the review shows assigned mappings only, so it cannot
  detect mappings we missed), not an independent validation of AI outputs (no AI output is shown or reviewed) and not a
  validation of any prevalence benchmark.
  1. Two families, each estimated on its own and NEVER pooled with the other: AREA (the ten areas of the primary
     analysis, 5 or 6 units each) and ROW (the ten Figure 2 rows, 4 units each), with ROW_BENCHMARKED (the 9 rows of the
     Figure 3 model, Pain excluded) as a secondary domain (PROPOSED, gate G-EST-01). Hajek ratio estimate with
     stratified linearization variance and the Wilson interval at n_eff (validation/mu8_estimators.py).
     Rule R0 (primary): final CANNOT_TELL and unresolved units leave the denominator.
     Rule R2 (alternative denominator): final CANNOT_TELL and unresolved units count as not confirmed.
     A unit answered by one reviewer only has no final reference (INCOMPLETE) and leaves both rules (PROPOSED, G-EST-01).
  2. Every category (stratum): counts only (no stratum holds 10 determinate units).
  3. The four subgroup strata (rule D kept, rule D removed, rule K kept, rule K removed): counts only, KEEP and REMOVE
     reported separately, never pooled with each other or with a family.
  4. Agreement of the two reviewers on the INITIAL and the effective answers, by family (AREA, ROW, SG) only: percent
     agreement and Cohen's kappa over AGREE, DISAGREE and CANNOT_TELL, with a percentile bootstrap interval. No statistic
     is computed over all units together.
  5. Routing, final status, reason codes and uncertainty flags.
Overlap setting (gate G-OVERLAP-01, read from the design rows): ALLOW uses the stratified weights N_h / n_h and, when a
trial holds two or more units of one family, the larger of the stratified and the trial-cluster variance, with n_eff
capped at the number of trials (PROPOSED, G-EST-01); the bootstrap then resamples trials. ONE_PER_TRIAL needs the Monte
Carlo inclusion probabilities (--probabilities, UNIT_PROBABILITIES_v8_ONE_PER_TRIAL_PROPOSED_PRIVATE.csv) and uses weights
1 / pi without the finite population correction.

Refusals (exit code 3, message starts with REFUSED): a format other than 7.0; a design version other than v8; a file whose
SHA-256 differs from the manifest; a unit list, assignment set or design-row hash that differs from the freeze (or from
--design-manifest); a stratum whose number of units differs from its design n or from the design manifest; a category
outside the v8 vocabulary (listed, never dropped); a missing slot or unit; mode other than FORMAL; a synthetic bundle
without --allow-synthetic; ONE_PER_TRIAL without probabilities for every unit.

Usage (Python 3.10 or later with pandas and numpy):
  python performance_analysis_v8.py --bundle BUNDLE_DIR --out NEW_DIR [--design-manifest freeze_manifest_v8_ALT.json]
         [--probabilities UNIT_PROBABILITIES.csv] [--bootstrap-reps 2000] [--seed 2026102408] [--allow-synthetic]
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
import mu8_bundle as B  # noqa: E402
import mu8_estimators as E  # noqa: E402
import mu81_observations as V81  # noqa: E402
import mu82_history as V82  # noqa: E402

FORMAT = "7.0"
DESIGN_PREFIXES = ("review-design-v8", "SYN-8")
ANSWERS = ["AGREE", "DISAGREE", "CANNOT_TELL"]
AREAS = ["PATHOLOGICAL", "ONCOLOGY", "NEUROLOGICAL", "IMMUNE", "MENTAL_HEALTH", "RESPIRATORY", "INFECTIOUS", "METABOLIC",
         "UROGENITAL", "CARDIOVASCULAR"]
ROWS = ["CAN_ALL", "DIAB", "DEP", "OBE", "AST", "COPD", "COV", "SCZ", "HTN", "PAIN"]
BENCHMARKED_ROWS = ROWS[:-1]
SUBGROUPS = ["RULE_D_KEPT", "RULE_D_REMOVED", "RULE_K_KEPT", "RULE_K_REMOVED"]
VOCABULARY = {"AREA": set(AREAS), "ROW": set(ROWS), "SG": set(SUBGROUPS)}
SG_PARENT = {"RULE_D_KEPT": "Diabetes Mellitus", "RULE_D_REMOVED": "Diabetes Mellitus", "RULE_K_KEPT": "Neoplasms",
             "RULE_K_REMOVED": "Neoplasms"}
REVIEWED_STATUSES = {"CONCORDANT", "ADJUDICATED", "CANNOT_TELL_BY_RULE", "UNRESOLVED"}
FILES = ["units.csv", "unit_design.csv", "independent_judgments.csv", "final_reference.csv"]
FAMILY_DOMAINS = ("AREA", "ROW", "ROW_BENCHMARKED")


class Refused(Exception):
    pass


def refuse_unless(cond: bool, msg: str) -> None:
    if not cond:
        raise Refused(msg)


def verify_judgment_reference_consistency(J: pd.DataFrame, R: pd.DataFrame) -> None:
    """Check the relationships in the existing database export views, not a new clinical rule.

    This verifies the exported initial/effective endpoints only. Format 7.0 omits
    intermediate revisions and judgment content hashes, so it cannot independently
    reproduce the database's full snapshot hash.
    """
    payload = ("answer", "reason", "note", "uncertain")
    required_j = {"judgment_status", "n_revisions", "first_submitted_at", "last_submitted_at"}
    required_j.update(f"{field}_{stage}" for field in payload for stage in ("initial", "effective"))
    required_r = {"routing", "final_answer", "final_status", "adjudication_status", "adjudication_basis",
                  "adjudication_reason_code", "adjudication_disagreement_reason_code"}
    required_r.update(f"answer_{stage}_slot{slot}" for stage in ("initial", "effective") for slot in (1, 2))
    refuse_unless(required_j <= set(J.columns) and required_r <= set(R.columns),
                  "judgment/reference export is missing required columns")
    refuse_unless(J.judgment_status.isin(["ANSWERED", "NOT_ANSWERED"]).all(), "unknown judgment status")
    refuse_unless(J.n_revisions.str.fullmatch(r"0|[1-9][0-9]*").all(), "invalid revision count")
    answered = J.judgment_status.eq("ANSWERED")
    blank_columns = [f"{f}_{s}" for f in payload for s in ("initial", "effective")]
    blank_columns += ["first_submitted_at", "last_submitted_at"]
    refuse_unless(J.loc[~answered, blank_columns].eq("").all().all()
                  and J.loc[~answered, "n_revisions"].eq("0").all(),
                  "unanswered assignments must not contain judgment data")
    for stage in ("initial", "effective"):
        a, reason, flag = (J.loc[answered, f"{field}_{stage}"] for field in ("answer", "reason", "uncertain"))
        refuse_unless(a.isin(ANSWERS).all(), "unknown reviewer answer")
        refuse_unless(flag.isin(["true", "false"]).all(), "uncertainty must be explicitly true or false")
        refuse_unless(a.eq("DISAGREE").equals(reason.ne("")), "disagreement reason does not match reviewer answer")
    unrevised = answered & J.n_revisions.eq("0")
    for field in payload:
        refuse_unless(J.loc[unrevised, f"{field}_initial"].equals(J.loc[unrevised, f"{field}_effective"]),
                      "initial/effective judgments differ without a revision")
    for row in J.loc[answered].itertuples():
        try:
            first = dt.datetime.fromisoformat(row.first_submitted_at.replace("Z", "+00:00"))
            last = dt.datetime.fromisoformat(row.last_submitted_at.replace("Z", "+00:00"))
        except ValueError:
            raise Refused("invalid judgment timestamp") from None
        refuse_unless(first.tzinfo is not None and last.tzinfo is not None, "judgment timestamps need time zones")
        refuse_unless(first <= last and (row.n_revisions != "0" or first == last),
                      "judgment timestamps contradict revision history")
    # Slot cardinality is checked by the caller before this join.
    ji = J.assign(reviewer_slot=J.reviewer_slot.astype(int)).set_index(["unit_id", "reviewer_slot"])
    adjudication_columns = ("adjudication_status", "adjudication_basis", "adjudication_reason_code",
                            "adjudication_disagreement_reason_code")
    adjudication_reasons = {"", "CONSTRUCT_BOUNDARY", "POLICY_RULE_INTERPRETATION", "MESH_PLACEMENT_MISLEADING",
                           "TRIAL_CONTEXT", "PACKET_INSUFFICIENT", "MULTILABEL_OR_CROSS_AREA", "OTHER"}
    for row in R.itertuples():
        for slot in (1, 2):
            for stage in ("initial", "effective"):
                refuse_unless(getattr(row, f"answer_{stage}_slot{slot}") == ji.at[(row.unit_id, slot), f"answer_{stage}"],
                              "reference answers differ from independent judgments")
        a1, a2 = row.answer_effective_slot1, row.answer_effective_slot2
        if not a1 or not a2:
            routing, final, status = "INCOMPLETE", "", "INCOMPLETE"
        elif a1 == a2:
            routing = "BOTH_CANNOT_TELL" if a1 == "CANNOT_TELL" else f"CONCORDANT_{a1}"
            final, status = a1, "CANNOT_TELL_BY_RULE" if a1 == "CANNOT_TELL" else "CONCORDANT"
        else:
            routing = "ROUTED"
            refuse_unless(row.adjudication_disagreement_reason_code in adjudication_reasons,
                          "unknown adjudication disagreement reason")
            if row.adjudication_status == "UNRESOLVED_ESCALATED":
                final, status = "", "UNRESOLVED"
                refuse_unless(row.adjudication_basis == "NONE" and row.adjudication_reason_code == "",
                              "unresolved adjudication must not claim a decision or reviewer basis")
            else:
                refuse_unless(row.adjudication_status == "DISCORDANT_RESOLVED", "routed reference lacks completed adjudication")
                final, status = row.final_answer, "ADJUDICATED"
                refuse_unless(final in ("AGREE", "DISAGREE"), "resolved adjudication needs a determinate answer")
                expected_basis = "REVIEWER_1" if a1 == final else "REVIEWER_2" if a2 == final else "NEITHER"
                refuse_unless(row.adjudication_basis == expected_basis, "adjudication basis contradicts reviewer answers")
                refuse_unless((final == "DISAGREE") == (row.adjudication_reason_code != ""),
                              "disagreement reason does not match adjudicated answer")
        refuse_unless(row.routing == routing and row.final_answer == final and row.final_status == status,
                      "final reference contradicts reviewer answers or adjudication")
        if routing != "ROUTED":
            refuse_unless(all(getattr(row, col) == "" for col in adjudication_columns),
                          "non-routed reference must not contain adjudication data")


def verify_freeze_inventory(U: pd.DataFrame, J: pd.DataFrame, freeze: dict) -> None:
    """Reproduce the queue and packet-inventory hashes from the existing export.

    Packet bytes are not exported. This checks their recorded digests against the
    freeze, not the evidence text itself or the authenticity of the manifest.
    """
    refuse_unless("packet_sha256" in U and {"queue_position", "reviewer_pseudo_id"} <= set(J.columns),
                  "packet inventory or queue columns missing")
    refuse_unless(U.packet_sha256.str.fullmatch(r"[0-9a-f]{64}").all(), "invalid packet digest")
    packets_hash = B.sha256_text("\n".join(U.sort_values("unit_id").packet_sha256))
    refuse_unless(packets_hash == freeze.get("packets_sha256"), "packet inventory hash differs from the freeze")
    refuse_unless(J.queue_position.str.fullmatch(r"[1-9][0-9]*").all(), "queue positions must be positive integers")
    # Compare as canonical decimal strings, avoiding float rounding and unbounded int conversions.
    positions = {str(n) for n in range(1, len(U) + 1)}
    for slot in ("1", "2"):
        queue = J.loc[J.reviewer_slot == slot]
        refuse_unless(queue.queue_position.is_unique and set(queue.queue_position) == positions,
                      "each reviewer queue must contain positions 1 through the frozen unit count")
        refuse_unless(queue.reviewer_pseudo_id.ne("").all() and queue.reviewer_pseudo_id.nunique() == 1,
                      "each reviewer slot must identify one reviewer")
    refuse_unless(J.reviewer_pseudo_id.nunique() == 2, "independent queues require two distinct reviewers")
    rows = [(int(s), int(p), u) for s, p, u in J[["reviewer_slot", "queue_position", "unit_id"]].itertuples(index=False, name=None)]
    refuse_unless(B.queue_sha256(rows) == freeze.get("queue_sha256"), "queue hash differs from the freeze")


# ---------------------------------------------------------------------------------------------------------------------
# 1. Load and verify
# ---------------------------------------------------------------------------------------------------------------------
def load_bundle(d: Path, allow_synthetic: bool, design_manifest: Path | None, expected_manifest_sha256: str | None = None) -> dict:
    refuse_unless((d / "manifest.json").exists(), f"no manifest.json in {d}")
    if expected_manifest_sha256 is not None:
        refuse_unless(len(expected_manifest_sha256) == 64 and all(c in "0123456789abcdef" for c in expected_manifest_sha256)
                      and B.sha256_file(d / "manifest.json") == expected_manifest_sha256,
                      "manifest differs from the independently registered manifest hash")
    man = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
    refuse_unless(str(man.get("bundle_format_version")) in (FORMAT, "8.1", "8.2"), f"bundle format {man.get('bundle_format_version')!r}, expected {FORMAT}")
    refuse_unless(man.get("mode") == "FORMAL", f"mode {man.get('mode')!r}: only a FORMAL bundle is analysed")
    dv = str(man.get("design", {}).get("design_version", ""))
    refuse_unless(dv.startswith(DESIGN_PREFIXES), f"design version {dv!r} is not design v8 (a v7 bundle is read by performance_analysis_v7.py)")
    synthetic = dv.startswith("SYN-8") or str(man.get("status", "")).upper().startswith("SYNTHETIC")
    refuse_unless(allow_synthetic or not synthetic, "a SYNTHETIC bundle needs --allow-synthetic")
    for f in FILES:
        refuse_unless((d / f).exists(), f"missing {f}")
        refuse_unless(B.sha256_file(d / f) == man["files"].get(f), f"{f}: SHA-256 differs from the manifest")
    T = {f: pd.read_csv(d / f, dtype=str, keep_default_na=False) for f in FILES}
    U, D, J, R = (T[f] for f in FILES)
    # This remains an engineering test harness. Full snapshot authentication and
    # approved scientific interpretation are still required before real-data analysis.
    refuse_unless(dv.startswith("SYN-8") and D.nct_id.str.startswith("SYN-TRIAL-").all(),
                  "v8 integration is synthetic-only; real study analysis remains disabled")
    for frame in (U, D, R):
        refuse_unless(frame.unit_id.ne("").all() and frame.unit_id.is_unique,
                      "unit IDs must be nonempty and unique in each unit table")
    refuse_unless(set(U.unit_id) == set(D.unit_id) == set(R.unit_id) == set(J.unit_id),
                  "all four tables must cover exactly the frozen units")
    refuse_unless(all(frame["mode"].eq("FORMAL").all() for frame in (U, D, J, R)),
                  "non-FORMAL records cannot enter performance analysis")
    refuse_unless(U.record_category.eq("MAPPING_UNIT_FORMAL").all(),
                  "pilot, training and development records cannot enter performance analysis")
    ui, ri = U.set_index("unit_id"), R.set_index("unit_id").loc[U.unit_id]
    for column in ("family", "category", "unit_role", "mapping_code", "assignment_code", "assignment_status"):
        refuse_unless(ui[column].equals(ri[column]), "reference metadata differs from frozen units")
    unknown = sorted({f"{fa}|{c}" for fa, c in zip(U.family, U.category) if c not in VOCABULARY.get(fa, set())})
    refuse_unless(not unknown, f"categories outside the v8 vocabulary (logged, not dropped): {unknown}")
    expected_mapping = U.apply(lambda r: f"AREA_{r.category}" if r.family == "AREA" else
                               f"FIG2_ROW_{r.category}" if r.family == "ROW" else r.category[:6], axis=1)
    refuse_unless(U.mapping_code.equals(expected_mapping), "family/category differs from frozen mapping code")
    fz = man["freeze"]
    refuse_unless(B.unit_list_sha256(U.unit_id) == fz["unit_list_sha256"], "unit list hash differs from the freeze")
    D = D.set_index("unit_id", drop=False)
    refuse_unless({"design_row_sha256", "assignment_row_sha256"} <= set(D.columns), "individual row digests missing")
    drt = {u: B.design_row_text(u, D.at[u, "nct_id"], D.at[u, "frame_id"], D.at[u, "stratum"], int(D.at[u, "frame_stratum_size"]),
                                int(D.at[u, "n_sampled_in_stratum"]), D.at[u, "allocation_option"], D.at[u, "overlap_setting"],
                                int(D.at[u, "sampling_seed"]), D.at[u, "prn_key"]) for u in D.index}
    refuse_unless(B.set_sha256(drt) == fz["design_rows_sha256"], "design-row hash differs from the freeze")
    refuse_unless(all(D.at[u, "design_row_sha256"] == B.sha256_text(text) for u, text in drt.items()),
                  "individual design-row digest differs from its canonical fields")
    Ui = U.set_index("unit_id", drop=False)
    art = {u: B.assignment_row_text(D.at[u, "assignment_set_id"], u, Ui.at[u, "mapping_code"], Ui.at[u, "assignment_code"],
                                    Ui.at[u, "assignment_status"]) for u in Ui.index}
    refuse_unless(B.set_sha256(art) == fz["assignment_set_sha256"], "assignment-set hash differs from the freeze")
    refuse_unless(all(D.at[u, "assignment_row_sha256"] == B.sha256_text(text) for u, text in art.items()),
                  "individual assignment-row digest differs from its canonical fields")
    refuse_unless(set(U.unit_id) == set(D.index) == set(R.unit_id), "units, design rows and final reference cover different units")
    refuse_unless(J.reviewer_slot.isin(["1", "2"]).all(), "reviewer slot must be 1 or 2")
    slots = J.groupby("unit_id").reviewer_slot.apply(lambda s: sorted(s.astype(int)))
    refuse_unless(all(slots.get(u, []) == [1, 2] for u in U.unit_id), "every unit needs one row per reviewer slot (1 and 2)")
    verify_judgment_reference_consistency(J, R)
    verify_freeze_inventory(U, J, fz)
    refuse_unless(all(man.get("row_counts", {}).get(f) == len(T[f]) for f in FILES),
                  "manifest row counts differ from exported tables")
    refuse_unless(fz.get("n_units") == len(U), "freeze unit count differs from exported tables")
    refuse_unless(D.design_version.eq(dv).all()
                  and D.assignment_set_id.eq(man["design"].get("assignment_set_id")).all(),
                  "design rows differ from manifest design or assignment set")
    for column in ("frame_stratum_size", "n_sampled_in_stratum"):
        refuse_unless(D.groupby("stratum")[column].nunique().eq(1).all(),
                      "stratum sizes must be consistent within each stratum")
    cnt = D.groupby("stratum").unit_id.size()
    nh = D.groupby("stratum").n_sampled_in_stratum.first().astype(int)
    bad = [s for s in cnt.index if cnt[s] != nh[s]]
    refuse_unless(not bad, f"strata whose number of units differs from their design n: {bad}")
    ov = sorted(set(D.overlap_setting))
    refuse_unless(len(ov) == 1 and ov[0] in ("ALLOW", "ONE_PER_TRIAL"), f"one overlap setting expected, found {ov}")
    refuse_unless(man["design"].get("overlap_setting") == ov[0], "overlap setting differs from manifest design")
    refuse_unless(ov[0] != "ONE_PER_TRIAL" or D.nct_id.is_unique,
                  "ONE_PER_TRIAL contains a repeated trial")
    if design_manifest is not None:
        dm = json.loads(design_manifest.read_text(encoding="utf-8"))
        for k in ("unit_list_sha256", "assignment_set_sha256", "design_rows_sha256"):
            refuse_unless(dm.get(k) == fz.get(k), f"{k} differs between the bundle freeze and the design manifest")
        refuse_unless(dm.get("overlap_setting", ov[0]) == ov[0], "the bundle's overlap setting differs from the design manifest")
        want = {s["stratum"]: int(s["n_h"]) for s in dm.get("strata", [])}
        if want:
            got = {s: int(nh[s]) for s in nh.index}
            refuse_unless(got == want, f"the bundle's allocation differs from the design manifest: "
                                       f"{sorted(set(got.items()) ^ set(want.items()))}")
    bound, subtype_counts = None, None
    if str(man.get("bundle_format_version")) in ("8.1", "8.2"):
        bound, subtype_counts = V81.verify(d, man, U, D, J, refuse_unless)
        if man["bundle_format_version"] == "8.2":
            V82.verify(d, man, J, refuse_unless)
    else:
        refuse_unless(not dv.startswith("SYN-8-1-") and dv != "review-design-v8.1.0", "v8.1 requires bundle format 8.1 or 8.2")
    return {"manifest": man, "units": U, "design": D, "judgments": J, "final": R, "overlap": ov[0], "synthetic": synthetic,
            "bound_probabilities": bound, "subtype_counts": subtype_counts}


# ---------------------------------------------------------------------------------------------------------------------
# 2. Analysis frame
# ---------------------------------------------------------------------------------------------------------------------
def analysis_frame(b: dict, probabilities: Path | None) -> pd.DataFrame:
    D, R = b["design"], b["final"].set_index("unit_id")
    X = pd.DataFrame({"unit_id": D.index})
    U = b["units"].set_index("unit_id")
    X["family"] = X.unit_id.map(U.family)
    X["category"] = X.unit_id.map(U.category)
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
    if b["manifest"]["bundle_format_version"] in ("8.1", "8.2"):
        refuse_unless(probabilities is None, "bundle 8.1/8.2 uses its frozen probability binding, not an external override")
    if b["overlap"] == "ONE_PER_TRIAL":
        refuse_unless(b.get("bound_probabilities") is not None or probabilities is not None, "overlap ONE_PER_TRIAL needs --probabilities (Monte Carlo inclusion probabilities)")
        P = b["bound_probabilities"] if b.get("bound_probabilities") is not None else pd.read_csv(probabilities, dtype={"unit_id": str})
        col = "pi_i" if "pi_i" in P.columns else "pi_mc_ONE_PER_TRIAL" if "pi_mc_ONE_PER_TRIAL" in P.columns else "pi"
        refuse_unless(P.unit_id.is_unique and set(P.unit_id) == set(X.unit_id),
                      "probabilities must contain exactly one row per frozen unit")
        numeric = pd.to_numeric(P[col], errors="coerce")
        refuse_unless((np.isfinite(numeric) & numeric.gt(0) & numeric.le(1)).all(),
                      "inclusion probabilities must be finite and in (0, 1]")
        pm = dict(zip(P.unit_id, numeric))
        refuse_unless(all(u in pm and pm[u] > 0 for u in X.unit_id), "a unit has no Monte Carlo inclusion probability")
        X["w"] = X.unit_id.map(lambda u: 1.0 / pm[u])
    return X


# ---------------------------------------------------------------------------------------------------------------------
# 3. Estimates and summaries (each family on its own; no estimate over all units)
# ---------------------------------------------------------------------------------------------------------------------
def family_estimates(X: pd.DataFrame, overlap: str) -> pd.DataFrame:
    rows = []
    domains = {"AREA": X.family == "AREA", "ROW": X.family == "ROW",
               "ROW_BENCHMARKED": (X.family == "ROW") & X.category.isin(BENCHMARKED_ROWS)}
    for name, dom in domains.items():
        for rule in ("R0", "R2"):
            # only the units of the family enter: area units never enter a row estimate and the reverse
            fam = "ROW" if name.startswith("ROW") else name
            df = X[X.family == fam].assign(in_domain=dom[X.family == fam], d=X.loc[X.family == fam, f"d_{rule}"])
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


def agreement(b: dict, X: pd.DataFrame, reps: int, seed: int, overlap: str) -> pd.DataFrame:
    J = b["judgments"]
    wide = J.pivot(index="unit_id", columns="reviewer_slot", values=["answer_initial", "answer_effective"])
    fam = X.set_index("unit_id").family
    trial = X.set_index("unit_id").nct_id
    rows = []
    for which in ("answer_initial", "answer_effective"):
        w = wide[which].rename(columns=lambda c: int(c))
        both = w[(w[1].isin(ANSWERS)) & (w[2].isin(ANSWERS))]
        for name in ("AREA", "ROW", "SG"):
            idx = both.index[fam[both.index] == name]
            a, c = list(both.loc[idx, 1]), list(both.loc[idx, 2])
            k = E.cohen_kappa(a, c, ANSWERS)
            lo = hi = None
            repeated = bool(trial[idx].duplicated().any())
            if k["n"] >= 2 and k["kappa"] is not None:
                if overlap == "ALLOW" and repeated:
                    lo, hi = cluster_bootstrap_kappa(a, c, list(trial[idx]), reps, seed)
                else:
                    lo, hi = E.kappa_bootstrap_ci(a, c, ANSWERS, reps=reps, seed=seed)
            rows.append({"answers": "initial" if which == "answer_initial" else "effective", "domain": name,
                         "n_pairs": k["n"], "percent_agreement": k["po"], "expected_agreement": k["pe"],
                         "kappa": k["kappa"], "kappa_ci_low": lo, "kappa_ci_high": hi, "bootstrap_reps": reps,
                         "bootstrap_seed": seed, "bootstrap_unit": "trial" if (overlap == "ALLOW" and repeated) else "unit"})
    return pd.DataFrame(rows)


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
    return b["final"].groupby(["family", "routing", "final_status"]).size().reset_index(name="units")


def uncertainty_summary(b: dict) -> pd.DataFrame:
    J = b["judgments"]
    J = J[J.judgment_status == "ANSWERED"]
    J = J.assign(family=J.unit_id.map(b["final"].set_index("unit_id").family))
    return J.groupby(["family", "answer_initial", "uncertain_initial"]).size().reset_index(name="judgments")


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
    ap.add_argument("--expect-manifest-sha256", help="Independent registered manifest hash (not taken from the download)")
    ap.add_argument("--probabilities", type=Path)
    ap.add_argument("--bootstrap-reps", type=int, default=2000)
    ap.add_argument("--seed", type=int, default=2026102408)
    ap.add_argument("--allow-synthetic", action="store_true")
    a = ap.parse_args(argv)
    if a.out.exists():
        print(f"REFUSED: {a.out} exists; the analysis writes to a new folder", file=sys.stderr)
        return 3
    try:
        b = load_bundle(a.bundle, a.allow_synthetic, a.design_manifest, a.expect_manifest_sha256)
        X = analysis_frame(b, a.probabilities)
    except Refused as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        return 3
    fam = family_estimates(X, b["overlap"])
    cat = category_counts(X)
    agr = agreement(b, X, a.bootstrap_reps, a.seed, b["overlap"])
    out = {"family_estimates_v8.csv": fam, "category_counts_v8.csv": cat[cat.family != "SG"],
           "subgroup_counts_v8.csv": cat[cat.family == "SG"], "agreement_v8.csv": agr,
           "reason_codes_v8.csv": reason_counts(b, X), "routing_summary_v8.csv": routing_summary(b),
           "uncertainty_flags_v8.csv": uncertainty_summary(b)}
    if b.get("subtype_counts") is not None:
        out["diabetes_subtype_counts_v81.csv"] = b["subtype_counts"]
    a.out.mkdir(parents=True)
    for name, df in out.items():
        df.to_csv(a.out / name, index=False, lineterminator="\n")
    trace = []
    for r in fam.itertuples():
        trace.append({"quantity": f"{r.domain} {r.rule} clinician confirmation share", "value": r.estimate,
                      "text": fmt_ci(r.estimate, r.ci_low, r.ci_high), "source": "family_estimates_v8.csv",
                      "method": f"Hajek ratio, Wilson at n_eff; {r.status}"})
    for r in agr.itertuples():
        trace.append({"quantity": f"kappa, {r.answers} answers, {r.domain} units", "value": r.kappa,
                      "text": "" if r.kappa is None or r.kappa_ci_low is None else
                      f"{r.kappa:.2f} (95% CI {r.kappa_ci_low:.2f} to {r.kappa_ci_high:.2f}), n = {r.n_pairs} pairs",
                      "source": "agreement_v8.csv", "method": "Cohen's kappa, percentile bootstrap"})
    pd.DataFrame(trace).to_csv(a.out / "numbers_trace_analysis_v8.csv", index=False, lineterminator="\n")
    lines = [f"# Mapping-unit confirmation review over the ten areas: results (bundle {b['manifest']['bundle_format_version']}, design v8)", "",
             "SYNTHETIC ENGINEERING TEST ONLY. Estimator and rubric remain proposed; not study results.",
             f"Bundle: {a.bundle} (overlap setting {b['overlap']}{'; SYNTHETIC' if b['synthetic'] else ''}).",
             "Outcome: clinician confirmation of displayed assignments. Reviewers saw our assignment; the share says nothing "
             "about mappings we did not assign. Area and condition-row results are reported separately and never pooled.", ""]
    for r in fam.itertuples():
        lines.append(f"- {r.domain}, rule {r.rule}: {fmt_ci(r.estimate, r.ci_low, r.ci_high)}; {r.n_confirmed} of "
                     f"{r.n_determinate} units in the denominator confirmed ({r.status}).")
    lines += ["", "Categories (counts only, fewer than 10 determinate units each): category_counts_v8.csv.", "",
              "Subgroup strata (counts only, never pooled):"]
    for r in cat[cat.family == "SG"].itertuples():
        lines.append(f"- {r.category} ({r.direction}, {r.parent_row} row): {r.final_AGREE} AGREE, {r.final_DISAGREE} "
                     f"DISAGREE, {r.final_CANNOT_TELL} CANNOT_TELL, {r.unresolved} unresolved, {r.incomplete_single_review} "
                     "single review.")
    (a.out / "results_summary_v8.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    log = {"script": "performance_analysis_v8.py", "run_at_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "bundle": str(a.bundle), "bundle_manifest_sha256": B.sha256_file(a.bundle / "manifest.json"),
           "registered_manifest_verified": a.expect_manifest_sha256 is not None,
           "judgment_snapshot_verified": b["manifest"]["bundle_format_version"] == "8.2",
           "overlap_setting": b["overlap"], "synthetic": b["synthetic"], "n_units": int(len(X)),
           "bootstrap_reps": a.bootstrap_reps, "seed": a.seed,
           "outputs": {p.name: B.sha256_file(p) for p in sorted(a.out.iterdir())}}
    (a.out / "run_log_v8.json").write_text(json.dumps(log, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"units": len(X), "overlap": b["overlap"], "families": fam[["domain", "rule", "status"]].to_dict("records")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
