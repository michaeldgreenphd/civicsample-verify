"""SYNTHETIC ENGINEERING ONLY. Proposed analysis; no clinical study results."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Dict, List

import numpy as np
import pandas as pd

try:
    from analysis import performance_analysis_v4 as pa4
except ImportError:  # pragma: no cover
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from analysis import performance_analysis_v4 as pa4

SEED = 20261020
AREAS = ["oncology", "cardiovascular", "mental_health", "infectious", "metabolic", "neurological", "respiratory"]
EXPORT_ID = "00000000-0000-4000-8000-0000000000f4"
LOCK_ID = "FX-LOCK-4"
FROZEN_AT = "2030-01-10T00:00:00Z"
OPENED_AT = "2030-01-15T00:00:00Z"
CLOSED_AT = "2030-02-15T00:00:00Z"
LOCKED_AT = "2030-02-25T00:00:00Z"
REVIEWERS = ("FX-REV-A", "FX-REV-B")
ADJUDICATOR = "FX-ADJ-1"
TIER1_VERSION = "v1.1"

# (stratum, comparison cell, invented frame size N, sample size n, Tier 0, Tier 1 status, P(reference INCLUDE))
DESCRIPTOR_STRATA = (
    [("FX_GAIN", "ONEG_CPOS", 1, 1, "EXCLUDE", "INCLUDE", 0.5),
     ("FX_LOSS_HIGH", "OPOS_CNEG", 6, 6, "INCLUDE", "EXCLUDE", 0.3),
     ("FX_LOSS_OTHER", "OPOS_CNEG", 60, 20, "INCLUDE", "EXCLUDE", 0.35)]
    + [(f"FX_AGREE_POS_{a}", "OPOS_CPOS", 150, 6, "INCLUDE", "INCLUDE", 0.9) for a in AREAS]
    + [("FX_AGREE_NEG", "ONEG_CNEG", 40, 6, "EXCLUDE", "EXCLUDE", 0.15),
       ("FX_UNRES_IE", "OPOS_UNRES", 40, 4, "INCLUDE", "INSUFFICIENT_EVIDENCE", 0.6),
       ("FX_OOF_NEAR", "OOF_NEG", 400, 10, "EXCLUDE", "NOT_IN_DECISION_FILE", 0.08)]
)
# trial strata: (stratum, cell, N, n, Tier 0, Stage C trial status, P(reference INCLUDE at trial level))
TRIAL_STRATA = [("FX_T_DISC_LOSS", "T_DISC_LOSS", 20, 4, "INCLUDE", "EXCLUDE", 0.4),
                ("FX_T_AGREE_OPOS", "T_AGREE_OPOS", 10, 3, "INCLUDE", "INCLUDE", 0.8)]
REASONS = ["CONSTRUCT_BOUNDARY", "POLICY_RULE_INTERPRETATION", "MESH_PLACEMENT_MISLEADING", "TRIAL_CONTEXT",
           "PACKET_INSUFFICIENT", "MULTILABEL_OR_CROSS_AREA", "OTHER"]


def _truth(rng: np.random.Generator, p_inc: float, p_cd: float = 0.06, p_ii: float = 0.03) -> str:
    u = rng.random()
    if u < p_cd:
        return "CONTEXT_DEPENDENT"
    if u < p_cd + p_ii:
        return "INSUFFICIENT_INFORMATION"
    return "INCLUDE" if rng.random() < p_inc else "EXCLUDE"


def _reviewer(rng: np.random.Generator, truth: str, acc: float = 0.88) -> str:
    if rng.random() < acc:
        return truth
    others = [c for c in pa4.L1_CODES if c != truth]
    return others[int(rng.integers(len(others)))]


def _ts(base: str, hours: float) -> str:
    return (pd.Timestamp(base) + pd.Timedelta(hours=float(hours))).strftime("%Y-%m-%dT%H:%M:%SZ")


def build() -> Dict[str, pd.DataFrame]:
    rng = np.random.default_rng(SEED)
    P: List[dict] = []
    J: List[dict] = []
    A: List[dict] = []
    k = 0

    def add_case(stratum, cell, N, n, unit_type, area, levels):
        """levels: list of (determination_level, tier0, tier1_status, tier1_binary, stage_c, p_inc)."""
        nonlocal k
        k += 1
        cid = f"HO4-TESTFX-{k:04d}"
        dui = f"SYN-D{k:04d}"
        nct = f"SYN-NCT-{k:04d}" if unit_type == "TRIAL_AREA" else ""
        unit_id = f"{dui}::{area}" if unit_type == "DESCRIPTOR_AREA" else f"{nct}::{dui}::{area}"
        for (level, t0, st, t1, stage_c, p_inc) in levels:
            P.append({"prediction_set_id": "FX-PRED-4", "record_category": "HELDOUT_FORMAL", "case_id": cid,
                      "frame_unit_id": f"FX-U-{k:04d}", "unit_type": unit_type, "unit_id": unit_id, "nct_id": nct,
                      "descriptor_ui": dui, "area": area, "determination_level": level, "tier0_binary": t0,
                      "tier1_version": TIER1_VERSION, "tier1_status_raw": st, "tier1_binary": t1,
                      "stage_c_trial_status": stage_c, "prediction_frozen_at": _ts(FROZEN_AT, -24 - k / 10),
                      "selection_stratum": stratum, "variance_stratum": stratum, "variance_stratum_size": N,
                      "selection_probability": repr(n / N), "sampling_weight": repr(N / n), "comparison_cell": cell,
                      "impact_tier": "HIGH" if stratum.endswith("HIGH") else "STANDARD",
                      "policy_governed_neoplasm_GEN06": "true" if (area == "oncology" and k % 3 == 0) else "false",
                      "provenance_audit_result": "NO_DEVELOPMENT_FLAG"})
            p_cd = 0.35 if level == "DESCRIPTOR_LEVEL_IN_TRIAL_CASE" else 0.06
            truth = _truth(rng, p_inc, p_cd=p_cd)
            eff = [_reviewer(rng, truth), _reviewer(rng, truth)]
            for slot, rid, e in zip(("1", "2"), REVIEWERS, eff):
                revised = rng.random() < 0.06
                initial = _reviewer(rng, e, acc=0.0) if revised else e
                h0 = 24 + 6 * k + (0 if slot == "1" else 2)
                J.append({"export_id": EXPORT_ID, "record_category": "HELDOUT_FORMAL", "case_id": cid, "case_version": 1,
                          "review_module": "ONTOLOGY_AREA", "unit_type": unit_type, "unit_id": unit_id, "nct_id": nct,
                          "descriptor_ui": dui, "descriptor_name": f"Synthetic descriptor {k:04d}", "area": area,
                          "determination_level": level, "reviewer_slot": slot, "reviewer_pseudo_id": rid,
                          "decision_initial": initial, "decision_effective_preclose": e,
                          "n_revisions_preclose": 1 if revised else 0,
                          "uncertain": "true" if rng.random() < 0.1 else "false", "packet_issue_flag": "false",
                          "first_submitted_at": _ts(OPENED_AT, h0), "last_submitted_at": _ts(OPENED_AT, h0 + (30 if revised else 0))})
            agree = eff[0] == eff[1]
            if agree:   # D2 scope DISAGREEMENTS_ONLY: the shared answer is the reference by rule
                dec, status, basis, reason = eff[0], "CONCORDANT_ADOPTED_BY_RULE", "BOTH_REVIEWERS", ""
            elif rng.random() < 0.1:
                dec, status, basis, reason = "", "UNRESOLVED_ESCALATED", "NONE", REASONS[int(rng.integers(len(REASONS)))]
            else:
                dec = truth
                basis = "REVIEWER_1" if truth == eff[0] else ("REVIEWER_2" if truth == eff[1] else "NEITHER")
                status, reason = "DISCORDANT_RESOLVED", REASONS[int(rng.integers(len(REASONS)))]
            A.append({"export_id": EXPORT_ID, "record_category": "HELDOUT_FORMAL", "case_id": cid,
                      "determination_level": level, "adjudication_id": f"FX-ADJ4-{len(A) + 1:04d}",
                      "adjudicated_decision": dec, "adjudication_status": status, "adjudication_basis": basis,
                      "disagreement_reason_code": reason,
                      "adjudicator_pseudo_id": "RULE" if agree else ADJUDICATOR,
                      "adjudicator_role": "CONCORDANCE_RULE" if agree else "ADJUDICATOR", "adjudication_blinded": "true",
                      "adjudicator_exposed_to_index_labels": "false",
                      "post_unblinding_revision_exists": "true" if (len(A) % 17 == 5) else "false",
                      "adjudicated_at": _ts(CLOSED_AT, 24 + len(A)), "reference_lock_id": LOCK_ID})

    for i, (stratum, cell, N, n, t0, st, p_inc) in enumerate(DESCRIPTOR_STRATA):
        for j in range(n):
            area = stratum.replace("FX_AGREE_POS_", "") if stratum.startswith("FX_AGREE_POS_") else AREAS[(i + j) % len(AREAS)]
            t1 = pa4.pa3.expected_curated_binary(t0, st, "DESCRIPTOR_LEVEL")
            add_case(stratum, cell, N, n, "DESCRIPTOR_AREA", area, [("DESCRIPTOR_LEVEL", t0, st, t1, "", p_inc)])
    for stratum, cell, N, n, t0, stage_c, p_inc in TRIAL_STRATA:
        for j in range(n):
            add_case(stratum, cell, N, n, "TRIAL_AREA", "mental_health",
                     [("DESCRIPTOR_LEVEL_IN_TRIAL_CASE", t0, "CONTEXT_DEPENDENT", t0, "", 0.5),
                      ("TRIAL_LEVEL", t0, "CONTEXT_DEPENDENT", stage_c, stage_c, p_inc)])
    return {"independent_judgments": pd.DataFrame(J, columns=pa4.JUDGMENT_COLUMNS),
            "adjudicated_reference": pd.DataFrame(A, columns=pa4.ADJUDICATION_COLUMNS),
            "frozen_predictions": pd.DataFrame(P, columns=pa4.PREDICTION_COLUMNS)}


FILE_NAMES = {"independent_judgments": "synthetic_v4_independent_judgments.csv",
              "adjudicated_reference": "synthetic_v4_adjudicated_reference.csv",
              "frozen_predictions": "synthetic_v4_frozen_predictions.csv"}
MANIFEST_NAME = "synthetic_v4_bundle.manifest.json"


def _fake_hash(label: str) -> str:
    return hashlib.sha256(f"SYNTHETIC-{label}".encode("utf-8")).hexdigest()


def write(out_dir: Path) -> dict:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    frames = build()
    files = []
    for role in ("independent_judgments", "adjudicated_reference", "frozen_predictions"):
        path = out_dir / FILE_NAMES[role]
        frames[role].to_csv(path, index=False, lineterminator="\n")
        files.append({"name": path.name, "role": role, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                      "rows": int(len(frames[role]))})
    pred_sha = files[2]["sha256"]
    manifest = {
        "export_id": EXPORT_ID, "export_type": "ANALYSIS_BUNDLE", "export_format_version": "4.0", "mode": "FORMAL",
        "review_module": "ONTOLOGY_AREA", "created_at": "2030-02-26T09:00:00Z", "app_git_sha": "0000000",
        "db_schema_version": "FX-0003", "is_synthetic_fixture": True, "reference_locked": True,
        "reference_lock_id": LOCK_ID, "reference_locked_at": LOCKED_AT, "formal_phase_opened_at": OPENED_AT,
        "formal_phase_closed_at": CLOSED_AT, "freeze_manifest_id": "FX-FREEZE-4",
        "freeze_manifest_sha256": _fake_hash("FREEZE"), "frozen_at": FROZEN_AT,
        "frozen_sample_case_list_sha256": pa4.case_list_sha256(frames["frozen_predictions"].case_id.unique()),
        "frozen_prediction_set_sha256": pred_sha, "tier1_version_frozen": TIER1_VERSION,
        "ontology_version": "FX-ONT", "ontology_sha256": _fake_hash("ONTOLOGY"),
        "tier1_decision_file_sha256": _fake_hash("DECISION-FILE"), "tier0_mapping_sha256": _fake_hash("TIER0"),
        "rubric_version": "FX-RUBRIC-4", "rubric_sha256": _fake_hash("RUBRIC"),
        "sampling_design_version": "FX-SAMPLING-4", "provenance_audit_sha256": _fake_hash("PROVENANCE"),
        "extension_approved_by_amendment": False, "amendment_id": "", "adjudication_scope": "DISAGREEMENTS_ONLY",
        "note": "SYNTHETIC ENGINEERING ONLY. Analysis plan not approved. Not study data.", "files": files}
    (out_dir / MANIFEST_NAME).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent
    m = write(target)
    print(json.dumps(m["files"], indent=2))
