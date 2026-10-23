#!/usr/bin/env python3
"""
validation/fixtures/make_synthetic_v7_bundle.py  (review design v7; SYNTHETIC, public)

Writes a synthetic FORMAL export bundle in format 7.0 with the columns of the export views of NNNN_v7_mapping_units.sql,
for the tests of validation/performance_analysis_v7.py. Fictional trials (NCT99xxxxxx placeholders: the NCT99 prefix is
never a real record), synthetic frame sizes, Option A allocation (8 units per area, 4 per row, 1 per subgroup stratum:
96 primary and 4 subgroup units), planted answers drawn from stratum confirmation probabilities, and planted cases:
  one unit answered by one reviewer only (final INCOMPLETE), two CANNOT_TELL answers on one unit (final CANNOT_TELL by
  rule), one routed unit left UNRESOLVED, one revision that changes an answer (initial and effective answers differ),
  and with --setting ALLOW one trial that holds an Oncology unit and a Respiratory unit (trial clustering).
With --setting ONE_PER_TRIAL every trial holds one unit and unit_probabilities.csv carries an inclusion probability for
every unit (n_h / N_h scaled by a fixed factor, standing in for the Monte Carlo probabilities).
Usage: python make_synthetic_v7_bundle.py --out NEW_DIR [--setting ALLOW|ONE_PER_TRIAL] [--seed 7]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mu7_bundle as B  # noqa: E402

AREAS = ["ONCOLOGY", "CARDIOVASCULAR", "MENTAL_HEALTH", "INFECTIOUS", "METABOLIC", "NEUROLOGICAL", "RESPIRATORY"]
ROWS = ["CAN_ALL", "DIAB", "DEP", "OBE", "AST", "COPD", "COV", "SCZ", "HTN", "PAIN"]
SG = {"RULE_D_KEPT": "D1_KEEP_TYPE2", "RULE_D_REMOVED": "D2_REMOVE_OTHER_TYPE", "RULE_K_KEPT": "K_KEEP_MALIGNANT_COMPATIBLE",
      "RULE_K_REMOVED": "K_REMOVE_VERIFIED_NONMALIGNANT"}
# synthetic frame sizes (round numbers of the order of the planning frames; not the study's frames)
N_SYN = {"AREA": [8600, 1600, 1500, 900, 2600, 950, 3100], "ROW": [8600, 2000, 800, 700, 650, 600, 560, 520, 530, 740],
         "SG": [2000, 540, 8600, 150]}
P_TRUE = {"AREA": [0.97, 0.80, 0.95, 0.95, 0.97, 0.80, 0.75], "ROW": [0.98, 0.95, 0.95, 0.9, 0.95, 0.9, 0.95, 0.95, 0.9, 0.85],
          "SG": [0.95, 0.8, 0.95, 0.7]}
REASON = {"AREA": "NOT_THE_CONDITION_STUDIED", "ROW": "NOT_THE_CONDITION_STUDIED", "D1_KEEP_TYPE2": "TYPE_1_ONLY",
          "D2_REMOVE_OTHER_TYPE": "TYPE_2_STUDIED", "K_KEEP_MALIGNANT_COMPATIBLE": "BENIGN_NEOPLASM",
          "K_REMOVE_VERIFIED_NONMALIGNANT": "MALIGNANT_NEOPLASM_STUDIED"}
SET = "SYN7-ASSIGN-FIXTURE-01"
DESIGN = "SYN-7-FIXTURE"


def build(setting: str, seed: int) -> dict:
    rng = np.random.default_rng(seed)
    units, n_trial = [], 1000
    for fam, cats, n in (("AREA", AREAS, 8), ("ROW", ROWS, 4), ("SG", list(SG), 1)):
        for i, cat in enumerate(cats):
            for k in range(1, n + 1):
                n_trial += 1
                code = "IN_AREA" if fam == "AREA" else "IN_ROW" if fam == "ROW" else SG[cat]
                units.append({"unit_id": f"MU7-{fam}-{cat}-{k:03d}", "family": fam, "category": cat, "stratum": f"{fam}-{cat}",
                              "N_h": N_SYN[fam][i], "n_h": n, "p": P_TRUE[fam][i], "code": code,
                              "nct_id": f"NCT99{n_trial:06d}"})
    U = pd.DataFrame(units)
    if setting == "ALLOW":    # one trial in two strata: Oncology unit 001 and Respiratory unit 001
        U.loc[U.unit_id == "MU7-AREA-RESPIRATORY-001", "nct_id"] = U.loc[U.unit_id == "MU7-AREA-ONCOLOGY-001", "nct_id"].iloc[0]
    U["truth"] = rng.random(len(U)) < U.p
    ans = {}
    for r in U.itertuples():
        for slot in (1, 2):
            x = rng.random()
            a = ("AGREE" if (r.truth and x < 0.93) or (not r.truth and x < 0.15) else
                 "CANNOT_TELL" if x > 0.97 else "DISAGREE")
            ans[(r.unit_id, slot)] = a
    # planted cases
    ans[("MU7-ROW-DIAB-001", 1)] = ans[("MU7-ROW-DIAB-001", 2)] = "CANNOT_TELL"      # both CANNOT_TELL
    ans[("MU7-AREA-METABOLIC-001", 1)], ans[("MU7-AREA-METABOLIC-001", 2)] = "AGREE", "DISAGREE"   # routed, left unresolved
    incomplete = "MU7-AREA-NEUROLOGICAL-001"                                          # slot 2 never answered
    revised = ("MU7-ROW-CAN_ALL-001", 2)                                              # DISAGREE revised to AGREE
    ans[("MU7-ROW-CAN_ALL-001", 1)] = "AGREE"
    J, F = [], []
    for r in U.itertuples():
        eff = {}
        for slot in (1, 2):
            if r.unit_id == incomplete and slot == 2:
                J.append({"unit_id": r.unit_id, "mode": "FORMAL", "reviewer_slot": slot, "reviewer_pseudo_id": "R-SYN2",
                          "queue_position": 0, "judgment_status": "NOT_ANSWERED", "answer_initial": "", "reason_initial": "",
                          "note_initial": "", "uncertain_initial": "", "answer_effective": "", "reason_effective": "",
                          "note_effective": "", "uncertain_effective": "", "n_revisions": 0, "first_submitted_at": "",
                          "last_submitted_at": ""})
                continue
            a0 = "DISAGREE" if (r.unit_id, slot) == revised else ans[(r.unit_id, slot)]
            a1 = "AGREE" if (r.unit_id, slot) == revised else a0
            rc = lambda a: (REASON[r.family] if r.family != "SG" else REASON[r.code]) if a == "DISAGREE" else ""  # noqa: E731
            J.append({"unit_id": r.unit_id, "mode": "FORMAL", "reviewer_slot": slot, "reviewer_pseudo_id": f"R-SYN{slot}",
                      "queue_position": 0, "judgment_status": "ANSWERED", "answer_initial": a0, "reason_initial": rc(a0),
                      "note_initial": "synthetic note" if a0 == "DISAGREE" else "", "uncertain_initial": "false",
                      "answer_effective": a1, "reason_effective": rc(a1), "note_effective": "synthetic note" if a1 == "DISAGREE" else "",
                      "uncertain_effective": "false", "n_revisions": 1 if (r.unit_id, slot) == revised else 0,
                      "first_submitted_at": "2026-11-01T00:00:00.000000Z", "last_submitted_at": "2026-11-01T00:00:00.000000Z"})
            eff[slot] = a1
        a1, a2 = eff.get(1), eff.get(2)
        if a1 is None or a2 is None:
            routing, final, status = "INCOMPLETE", "", "INCOMPLETE"
        elif a1 == a2 == "AGREE":
            routing, final, status = "CONCORDANT_AGREE", "AGREE", "CONCORDANT"
        elif a1 == a2 == "DISAGREE":
            routing, final, status = "CONCORDANT_DISAGREE", "DISAGREE", "CONCORDANT"
        elif a1 == a2 == "CANNOT_TELL":
            routing, final, status = "BOTH_CANNOT_TELL", "CANNOT_TELL", "CANNOT_TELL_BY_RULE"
        else:
            routing = "ROUTED"
            if r.unit_id == "MU7-AREA-METABOLIC-001":
                final, status = "", "UNRESOLVED"
            else:
                final, status = ("AGREE" if r.truth else "DISAGREE"), "ADJUDICATED"
        adj_basis = "" if status != "ADJUDICATED" else ("REVIEWER_1" if a1 == final else "REVIEWER_2" if a2 == final else "NEITHER")
        F.append({"unit_id": r.unit_id, "mode": "FORMAL", "family": r.family, "category": r.category,
                  "unit_role": "SUBGROUP" if r.family == "SG" else "PRIMARY",
                  "mapping_code": f"AREA_{r.category}" if r.family == "AREA" else f"FIG2_ROW_{r.category}" if r.family == "ROW" else r.category[:6],
                  "assignment_code": r.code, "assignment_status": "ASSIGNED", "answer_initial_slot1": ans[(r.unit_id, 1)],
                  "answer_initial_slot2": "" if r.unit_id == incomplete else ("DISAGREE" if (r.unit_id, 2) == revised else ans[(r.unit_id, 2)]),
                  "answer_effective_slot1": a1 or "", "answer_effective_slot2": a2 or "", "routing": routing, "final_answer": final,
                  "final_status": status,
                  "adjudication_reason_code": (REASON[r.family] if r.family != "SG" else REASON[r.code]) if (status == "ADJUDICATED" and final == "DISAGREE") else "",
                  "adjudication_status": "DISCORDANT_RESOLVED" if status == "ADJUDICATED" else "UNRESOLVED_ESCALATED" if status == "UNRESOLVED" else "",
                  "adjudication_basis": adj_basis if status == "ADJUDICATED" else "NONE" if status == "UNRESOLVED" else "",
                  "adjudication_disagreement_reason_code": ""})
    UN = pd.DataFrame({"unit_id": U.unit_id, "mode": "FORMAL", "record_category": "MAPPING_UNIT_FORMAL", "family": U.family,
                       "category": U.category, "unit_role": np.where(U.family == "SG", "SUBGROUP", "PRIMARY"),
                       "mapping_code": [f["mapping_code"] for f in F], "assignment_code": U.code, "assignment_status": "ASSIGNED",
                       "parent_row_code": [("FIG2_ROW_DIAB" if c.startswith("RULE_D") else "FIG2_ROW_CAN_ALL") if f == "SG" else ""
                                           for f, c in zip(U.family, U.category)],
                       "packet_sha256": "0" * 64, "created_at": "2026-10-30T00:00:00.000Z"})
    prn = [B.sha256_text(f"1|{s}|{t}") for s, t in zip(U.stratum, U.nct_id)]
    DS = pd.DataFrame({"unit_id": U.unit_id, "mode": "FORMAL", "nct_id": U.nct_id, "frame_id": "SYN_FRAME", "stratum": U.stratum,
                       "frame_stratum_size": U.N_h, "n_sampled_in_stratum": U.n_h, "selection_probability": U.n_h / U.N_h,
                       "sampling_seed": 1, "prn_key": prn, "allocation_option": "A", "overlap_setting": setting,
                       "design_version": DESIGN, "freeze_status": "READY", "freeze_gate": ""})
    DS["design_row_sha256"] = [B.sha256_text(B.design_row_text(*x)) for x in zip(DS.unit_id, DS.nct_id, DS.frame_id, DS.stratum,
                               DS.frame_stratum_size, DS.n_sampled_in_stratum, DS.allocation_option, DS.overlap_setting,
                               DS.sampling_seed, DS.prn_key)]
    DS["assignment_set_id"] = SET
    DS["assignment_row_sha256"] = [B.sha256_text(B.assignment_row_text(SET, u, m, c, "ASSIGNED"))
                                   for u, m, c in zip(UN.unit_id, UN.mapping_code, UN.assignment_code)]
    probs = None
    if setting == "ONE_PER_TRIAL":
        probs = pd.DataFrame({"unit_id": U.unit_id, "pi_mc_ONE_PER_TRIAL": (U.n_h / U.N_h) * 0.97})
    return {"units": UN, "unit_design": DS, "independent_judgments": pd.DataFrame(J), "final_reference": pd.DataFrame(F),
            "probabilities": probs, "truth": U[["unit_id", "truth"]]}


def write(b: dict, out: Path, setting: str) -> Path:
    if out.exists():
        raise SystemExit(f"refusing to overwrite {out}")
    out.mkdir(parents=True)
    man = {"bundle_format_version": "7.0", "mode": "FORMAL", "status": "SYNTHETIC: make_synthetic_v7_bundle.py fixture",
           "design": {"design_version": DESIGN, "assignment_set_id": SET, "overlap_setting": setting, "n_primary_planned": 96,
                      "n_subgroup_planned": 4}, "files": {}, "row_counts": {}}
    for name in ("units", "unit_design", "independent_judgments", "final_reference"):
        p = out / f"{name}.csv"
        b[name].to_csv(p, index=False, lineterminator="\n")
        man["files"][p.name] = B.sha256_file(p)
        man["row_counts"][p.name] = int(len(b[name]))
    D = b["unit_design"]
    man["freeze"] = {"n_units": int(len(D)), "unit_list_sha256": B.unit_list_sha256(D.unit_id),
                     "assignment_set_sha256": B.sha256_text("\n".join(D.sort_values("unit_id").assignment_row_sha256)),
                     "design_rows_sha256": B.sha256_text("\n".join(D.sort_values("unit_id").design_row_sha256))}
    (out / "manifest.json").write_text(json.dumps(man, indent=1) + "\n", encoding="utf-8")
    if b["probabilities"] is not None:
        b["probabilities"].to_csv(out / "unit_probabilities.csv", index=False, lineterminator="\n")
    b["truth"].to_csv(out / "planted_truth_NOT_PART_OF_A_BUNDLE.csv", index=False, lineterminator="\n")
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--setting", default="ALLOW", choices=["ALLOW", "ONE_PER_TRIAL"])
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args(argv)
    write(build(a.setting, a.seed), a.out, a.setting)
    print(a.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
