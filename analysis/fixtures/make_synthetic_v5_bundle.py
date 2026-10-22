"""SYNTHETIC ENGINEERING ONLY. Proposed analysis; no clinical study results.

analysis/fixtures/make_synthetic_v5_bundle.py

Writes a SYNTHETIC export bundle in format 5.0 (EXPORT_TO_PERFORMANCE_SPEC_v5.md): the three files the app
writes from the v5 export views plus one manifest. Every identifier is synthetic (TLV5-TESTFX- cases,
SYN-NCT- trials, R-SYN1 / R-SYN2 reviewers); nothing here is study data, and the manifest says so
(is_synthetic_fixture = true), so performance_analysis_v5 refuses it unless allow_synthetic=True.

The bundle follows the database rules of migrations/0004_v5_trial_label_verification.sql exactly:
  * two reviewers; subgroup items are answered exactly when the same reviewer answers the condition row YES;
    a hidden subgroup item is exported as NOT_APPLICABLE (never blank);
  * DISAGREEMENTS_ONLY: concordant items (same answer AND same detail code) enter the reference by rule;
    discordant items are adjudicated (DISCORDANT_RESOLVED, with a v3 reason code); single answers are
    SINGLE_REVIEW_ADJUDICATED; one discordant item is UNRESOLVED_ESCALATED; a subgroup item that no reviewer
    was shown is NOT_APPLICABLE_BY_RULE; a case nobody submitted is NOT_REVIEWED;
  * one revision before the close, one single-reviewed case, one case not reviewed, one post-unblinding flag.

Usage (repository root on PYTHONPATH):
  python -m analysis.fixtures.make_synthetic_v5_bundle --out analysis/fixtures/synthetic_v5 [--scenario mixed|perfect]
The writer refuses to overwrite existing files.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

try:
    from analysis import performance_analysis_v5 as pa5
except ImportError:  # run from inside analysis/fixtures/
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import performance_analysis_v5 as pa5  # type: ignore

SEED = 20261022
STRATA = [("SYN_S1", 400, 12, "ONCOLOGY", "CAN_ALL"), ("SYN_S2", 300, 10, "METABOLIC", "DIAB"),
          ("SYN_S3", 200, 10, "MENTAL_HEALTH", "DEP"), ("SYN_S4", 100, 8, "RESPIRATORY", "COPD")]
SECOND_AREA = {"ONCOLOGY": "RESPIRATORY", "METABOLIC": "CARDIOVASCULAR", "MENTAL_HEALTH": "NEUROLOGICAL", "RESPIRATORY": "INFECTIOUS"}
SPURIOUS_AREA = {"ONCOLOGY": "NEUROLOGICAL", "METABOLIC": "NEUROLOGICAL", "MENTAL_HEALTH": "CARDIOVASCULAR", "RESPIRATORY": "CARDIOVASCULAR"}
TS = {"label_frozen_at": "2026-11-01T11:00:00Z", "frozen_at": "2026-11-01T12:00:00Z", "opened": "2026-11-02T09:00:00Z",
      "closed": "2026-11-21T17:00:00Z", "snapshot": "2026-11-21T17:30:00Z", "locked": "2026-11-26T10:00:00Z"}
LOCK_ID = "00000000-0000-4000-8000-00000000c0de"
LABEL_SET = "LBL5-TESTFX"
DESIGN_VERSION = "SYN-5"
REVIEWERS = {1: "R-SYN1", 2: "R-SYN2"}
ADJUDICATOR = "A-5A5A5A"


def _truth(rng: np.random.Generator, n_case: int, scenario: str) -> List[Dict[str, Any]]:
    """Synthetic 'truth' per case and the frozen labels derived from it (with planted label errors)."""
    out = []
    k = 0
    for stratum, N, n, area, row in STRATA:
        for _ in range(n):
            k += 1
            true_areas = {area} | ({SECOND_AREA[area]} if rng.random() < 0.3 else set())
            t0 = set(true_areas)
            if scenario == "mixed":
                if rng.random() < 0.2:
                    t0.add(SPURIOUS_AREA[area])                 # Tier 0 false positive
                if len(t0) > 1 and rng.random() < 0.1:
                    t0.discard(sorted(true_areas)[-1])          # Tier 0 false negative
            t1 = set(true_areas) if rng.random() < 0.9 else set(t0)
            rows = {row}
            true_rows = set(rows) if (scenario == "perfect" or rng.random() < 0.92) else set()
            dev = bool(rng.random() < 0.8)
            c = {"k": k, "case_id": f"TLV5-TESTFX-{k:04d}", "nct_id": f"SYN-NCT-{1000 + k}", "stratum": stratum, "N": N, "n": n,
                 "true_areas": true_areas, "t0": t0, "t1": t1, "rows": rows, "true_rows": true_rows, "dev": dev,
                 "rule_d": None, "rule_k": None, "true_sg_d": None, "true_sg_k": None}
            if row == "DIAB":
                c["rule_d"] = "D1_KEEP_TYPE2" if rng.random() < 0.75 else "D4A_KEEP_UNRESOLVED_PARENT_ONLY"
                c["true_sg_d"] = ("TYPE_2", None) if (scenario == "perfect" or rng.random() < 0.85) else ("OTHER", "PREDIABETES")
            if row == "CAN_ALL":
                c["rule_k"] = "K_KEEP_MALIGNANT_COMPATIBLE" if rng.random() < 0.8 else "K_KEEP_HEURISTIC_NONMALIGNANT_CLASS"
                c["true_sg_k"] = ("MALIGNANT", None) if (scenario == "perfect" or c["rule_k"] == "K_KEEP_MALIGNANT_COMPATIBLE") \
                    else ("NON_MALIGNANT", "BENIGN_NEOPLASM")
            out.append(c)
    assert len(out) == n_case
    return out


def _answers(c: Dict[str, Any], rng: np.random.Generator, scenario: str, noise: float) -> Dict[str, Tuple[str, Optional[str]]]:
    """One reviewer's 19 answers (answer, detail) given the case truth."""
    ans: Dict[str, Tuple[str, Optional[str]]] = {}
    for a in pa5.AREA_KEYS:
        v = "YES" if a in c["true_areas"] else "NO"
        if scenario == "mixed" and rng.random() < noise:
            v = rng.choice(["CONTEXT_DEPENDENT", "NO" if v == "YES" else "YES"])
        ans[f"AREA_{a}"] = (str(v), None)
    for r in pa5.ROW_KEYS:
        v = "YES" if r in c["true_rows"] else "NO"
        if scenario == "mixed" and rng.random() < noise / 2:
            v = "INSUFFICIENT_INFORMATION"
        ans[f"FIG2_ROW_{r}"] = (v, None)
    ans["SG_DIABETES_TYPE"] = (c["true_sg_d"] or ("UNCLEAR", None)) if ans["FIG2_ROW_DIAB"][0] == "YES" else (pa5.NOT_APPLICABLE, None)
    ans["SG_NEOPLASM_MALIGNANCY"] = (c["true_sg_k"] or ("UNCLEAR", None)) if ans["FIG2_ROW_CAN_ALL"][0] == "YES" else (pa5.NOT_APPLICABLE, None)
    return ans


def build(seed: int = SEED, scenario: str = "mixed") -> Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, Dict[str, Any]]:
    rng = np.random.default_rng(seed)
    n_case = sum(s[2] for s in STRATA)
    cases = _truth(rng, n_case, scenario)
    # ---- frozen labels -----------------------------------------------------------------------------------
    L = []
    for c in cases:
        p = c["n"] / c["N"]
        design = {"nct_id": c["nct_id"], "frame": "SYN_FRAME", "stratum": c["stratum"], "variance_stratum": c["stratum"],
                  "frame_stratum_size": c["N"], "n_sampled_in_stratum": c["n"], "selection_probability": repr(p),
                  "sampling_weight": repr(1 / p), "dev_linked": c["dev"], "tier1_eligible": not c["dev"], "design_version": DESIGN_VERSION}
        base = {"label_set_id": LABEL_SET, "record_category": "LABEL_VERIFICATION_FORMAL", "case_id": c["case_id"], "mode": "FORMAL"}
        for a in pa5.AREA_KEYS:
            L.append({**base, "nct_id": c["nct_id"], "item_family": "AREA", "item_code": f"AREA_{a}",
                      "label_primary": "YES" if a in c["t0"] else "NO", "label_secondary": "YES" if a in c["t1"] else "NO",
                      "label_informational": "YES" if a in c["t1"] else "NO", "dev_linked_area": c["dev"],
                      "label_frozen_at": TS["label_frozen_at"], **{k: v for k, v in design.items() if k != "nct_id"}})
        for r in pa5.ROW_KEYS:
            L.append({**base, "nct_id": c["nct_id"], "item_family": "FIG2_ROW", "item_code": f"FIG2_ROW_{r}",
                      "label_primary": "YES" if r in c["rows"] else "NO", "label_secondary": None, "label_informational": None,
                      "dev_linked_area": None, "label_frozen_at": TS["label_frozen_at"], **{k: v for k, v in design.items() if k != "nct_id"}})
        for item, val in (("RULE_D", c["rule_d"]), ("RULE_K", c["rule_k"])):
            if val:
                L.append({**base, "nct_id": c["nct_id"], "item_family": item, "item_code": item, "label_primary": val,
                          "label_secondary": None, "label_informational": None, "dev_linked_area": None,
                          "label_frozen_at": TS["label_frozen_at"], **{k: v for k, v in design.items() if k != "nct_id"}})
    L = pd.DataFrame(L)[pa5.LABEL_COLUMNS_V5]

    # ---- reviewer answers ----------------------------------------------------------------------------------
    not_reviewed = cases[-1]["case_id"]          # last case of SYN_S4: nobody submitted
    single = cases[-2]["case_id"]                # second-to-last: only reviewer 1 submitted
    revised = cases[0]["case_id"]                # reviewer 1 revised one answer before the close
    eff: Dict[Tuple[str, int], Dict[str, Tuple[str, Optional[str]]]] = {}
    ini: Dict[Tuple[str, int], Dict[str, Tuple[str, Optional[str]]]] = {}
    for c in cases:
        for slot in (1, 2):
            if c["case_id"] == not_reviewed or (c["case_id"] == single and slot == 2):
                continue
            a = _answers(c, rng, scenario, noise=0.06 if slot == 1 else 0.09)
            eff[(c["case_id"], slot)] = a
            ini[(c["case_id"], slot)] = dict(a)
    # planted (mixed scenario): both reviewers answer one area item CONTEXT_DEPENDENT on the second case, so the
    # reference holds an explicit indeterminate answer by rule (state 2 of the three-state rule)
    if scenario == "mixed":
        for slot in (1, 2):
            eff[(cases[1]["case_id"], slot)]["AREA_CARDIOVASCULAR"] = ("CONTEXT_DEPENDENT", None)
            ini[(cases[1]["case_id"], slot)]["AREA_CARDIOVASCULAR"] = ("CONTEXT_DEPENDENT", None)
    # the revision: reviewer 1 first answered the case's first area item the other way, then corrected it
    item0 = f"AREA_{STRATA[0][3]}"
    first = eff[(revised, 1)][item0][0]
    ini[(revised, 1)][item0] = ("NO" if first == "YES" else "YES", None)
    J = []
    k = 0
    for (cid, slot), a in sorted(eff.items()):
        c = next(x for x in cases if x["case_id"] == cid)
        k += 1
        n_rev = 1 if (cid == revised and slot == 1) else 0
        first_ts = pd.Timestamp("2026-11-03T09:00:00Z") + pd.Timedelta(minutes=37 * k)
        last_ts = first_ts + pd.Timedelta(days=2) if n_rev else first_ts
        for item in pa5.REVIEWER_ITEMS:
            J.append({"record_category": "LABEL_VERIFICATION_FORMAL", "case_id": cid, "mode": "FORMAL", "nct_id": c["nct_id"],
                      "item_family": pa5.item_family(item), "item_code": item, "reviewer_slot": slot, "reviewer_pseudo_id": REVIEWERS[slot],
                      "answer_initial": ini[(cid, slot)][item][0], "answer_effective_preclose": a[item][0],
                      "detail_initial": ini[(cid, slot)][item][1], "detail_effective": a[item][1], "n_revisions_preclose": n_rev,
                      "uncertain": a[item][0] in pa5.NONDIRECTIONAL, "packet_issue_flag": False,
                      "first_submitted_at": first_ts.strftime("%Y-%m-%dT%H:%M:%SZ"), "last_submitted_at": last_ts.strftime("%Y-%m-%dT%H:%M:%SZ")})
    J = pd.DataFrame(J)[pa5.JUDGMENT_COLUMNS_V5]

    # ---- adjudicated reference (the rules of v_tlv5_adjudicated_reference) ----------------------------------
    A = []
    n_unresolved = 0
    k = 0
    for c in cases:
        cid = c["case_id"]
        n_rev = sum((cid, s) in eff for s in (1, 2))
        truth = _answers(c, np.random.default_rng(0), "perfect", 0.0)      # the adjudicator's decision: the truth
        for item in pa5.REVIEWER_ITEMS:
            got = [eff[(cid, s)][item] for s in (1, 2) if (cid, s) in eff]
            got = [g for g in got if g[0] != pa5.NOT_APPLICABLE]
            row = {"record_category": "LABEL_VERIFICATION_FORMAL", "case_id": cid, "mode": "FORMAL", "item_family": pa5.item_family(item),
                   "item_code": item, "n_reviewers_submitted": n_rev, "n_reviewer_answers": len(got), "disagreement_reason_code": None,
                   "adjudication_blinded": True, "post_unblinding_revision_exists": False, "reference_lock_id": LOCK_ID}
            rule = {"adjudication_id": f"RULE-{cid}-{item}", "adjudicator_pseudo_id": "RULE", "adjudicator_role": "RULE",
                    "adjudicated_at": TS["locked"]}
            if n_rev == 0:
                row.update(rule, reference_answer=None, reference_detail=None, adjudication_status="NOT_REVIEWED", adjudication_basis="NONE")
            elif not got:
                row.update(rule, reference_answer=pa5.NOT_APPLICABLE, reference_detail=None, adjudication_status="NOT_APPLICABLE_BY_RULE",
                           adjudication_basis="NONE")
            elif len(got) == 2 and got[0] == got[1]:
                row.update(rule, reference_answer=got[0][0], reference_detail=got[0][1], adjudication_status="CONCORDANT_ADOPTED_BY_RULE",
                           adjudication_basis="BOTH_REVIEWERS")
            else:
                k += 1
                adj = {"adjudication_id": f"ADJ5-{hashlib.sha256(f'{cid}{item}'.encode()).hexdigest()[:32]}",
                       "adjudicator_pseudo_id": ADJUDICATOR, "adjudicator_role": "ADJUDICATOR",
                       "adjudicated_at": (pd.Timestamp("2026-11-22T09:00:00Z") + pd.Timedelta(minutes=11 * k)).strftime("%Y-%m-%dT%H:%M:%SZ")}
                dec = truth[item] if truth[item][0] != pa5.NOT_APPLICABLE else got[0]
                if len(got) == 1:
                    row.update(adj, reference_answer=dec[0], reference_detail=dec[1], adjudication_status="SINGLE_REVIEW_ADJUDICATED",
                               adjudication_basis="REVIEWER_1" if dec == got[0] else "NEITHER")
                elif n_unresolved == 0 and item in pa5.AREA_ITEMS and scenario == "mixed":
                    n_unresolved += 1
                    row.update(adj, reference_answer=None, reference_detail=None, adjudication_status="UNRESOLVED_ESCALATED",
                               adjudication_basis="NONE", disagreement_reason_code="CONSTRUCT_BOUNDARY")
                else:
                    basis = "REVIEWER_1" if dec == got[0] else ("REVIEWER_2" if dec == got[1] else "NEITHER")
                    row.update(adj, reference_answer=dec[0], reference_detail=dec[1], adjudication_status="DISCORDANT_RESOLVED",
                               adjudication_basis=basis, disagreement_reason_code="TRIAL_CONTEXT" if item in pa5.AREA_ITEMS else "CONSTRUCT_BOUNDARY")
            A.append(row)
    A = pd.DataFrame(A)[pa5.REFERENCE_COLUMNS_V5]
    # one post-unblinding revision flag (the primary reference row is unchanged)
    A.loc[A.index[A.adjudication_status == "CONCORDANT_ADOPTED_BY_RULE"][0], "post_unblinding_revision_exists"] = True

    manifest = {
        "export_id": "00000000-0000-4000-8000-0000000e5e5e", "export_format_version": "5.0", "mode": "FORMAL",
        "created_at": "2026-11-26T12:00:00Z", "app_git_sha": "synthetic", "db_schema_version": "5.0.0",
        "is_synthetic_fixture": True, "design_version": DESIGN_VERSION, "adjudication_scope": "DISAGREEMENTS_ONLY",
        "label_set_id": LABEL_SET, "frozen_at": TS["frozen_at"],
        "frozen_case_list_sha256": pa5.case_list_sha256(L.case_id.unique()), "frozen_label_rows_sha256": pa5.label_rows_sha256(L),
        "formal_phase_opened_at": TS["opened"], "formal_phase_closed_at": TS["closed"], "formal_phase_status": "CLOSED_INCOMPLETE",
        "snapshot_taken_at": TS["snapshot"], "snapshot_sha256": pa5.judgments_snapshot_sha256(J),
        "snapshot_rows": int(len(J)), "reference_locked": True, "reference_lock_id": LOCK_ID, "reference_locked_at": TS["locked"],
        "rubric_version": "REVIEW_RUBRIC_v5-DRAFT", "rubric_sha256": hashlib.sha256(b"synthetic rubric").hexdigest(), "files": [],
    }
    return J, A, L, manifest


FILE_NAMES = {"independent_judgments": "synthetic_v5_independent_judgments.csv",
              "adjudicated_reference": "synthetic_v5_adjudicated_reference.csv",
              "frozen_labels": "synthetic_v5_frozen_labels.csv"}
MANIFEST_NAME = "synthetic_v5_bundle.manifest.json"


def write(out_dir: str, seed: int = SEED, scenario: str = "mixed", overwrite: bool = False) -> Path:
    """Write the bundle; refuses to overwrite unless overwrite=True (tests write into temporary folders)."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    J, A, L, manifest = build(seed, scenario)
    files = []
    for role, df in (("independent_judgments", J), ("adjudicated_reference", A), ("frozen_labels", L)):
        p = out / FILE_NAMES[role]
        if p.exists() and not overwrite:
            raise FileExistsError(f"refusing to overwrite {p}")
        df.to_csv(p, index=False, lineterminator="\n")
        files.append({"role": role, "name": p.name, "sha256": hashlib.sha256(p.read_bytes()).hexdigest(), "rows": int(len(df))})
    manifest["files"] = files
    mp = out / MANIFEST_NAME
    if mp.exists() and not overwrite:
        raise FileExistsError(f"refusing to overwrite {mp}")
    mp.write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    return mp


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--scenario", choices=["mixed", "perfect"], default="mixed")
    a = ap.parse_args()
    print(write(a.out, a.seed, a.scenario))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
