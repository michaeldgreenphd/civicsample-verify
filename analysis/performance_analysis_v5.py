"""
analysis/performance_analysis_v5.py

Export-to-performance analysis for clinical review design v5: trial-level verification of the
therapeutic-area labels used in the analysis. On IDENTICAL sampled trials it compares the blinded
adjudicated clinical reference with (a) the Tier 0 labels the manuscript uses (parent MeSH categories,
deterministic, frozen) and (b) the curated v1.2 labels (Tier 1, PROVISIONAL [PENDING CLINICAL REVIEW]),
and it verifies the Figure 2 condition-row labels and the rule D (diabetes type) and rule K (malignancy)
outcomes. Reviewer-reviewer agreement is reported from the INDEPENDENT judgments, separately, as
consistency between two clinicians; it is never presented as validation.

Status: reference implementation, tested on SYNTHETIC data only. No clinical review has taken place.
Nothing this module prints for a synthetic fixture or a pilot bundle is a study result.
Specification: EXPORT_TO_PERFORMANCE_SPEC_v5.md. Database contract: migrations/0004_v5_trial_label_verification.sql.

What it reuses (imported unchanged, not re-implemented):
  * analysis/agreement_metrics.py (v2): Wilson intervals, raw agreement, Cohen's kappa;
  * analysis/performance_analysis_v3.py (v3): weighted_ratio_v3 (Hajek ratio, stratified linearization
    with finite population correction, Wilson interval at the effective sample size capped at the
    unweighted domain count; not estimable below 10 units), the boolean reader and the slot formatter.

Estimands (identical definitions to scripts/v5_design.estimand_vectors, the planning simulation):
  E1  pooled Tier 0 PPV over trial-area pairs (unit: trial; numerator and denominator are per-trial counts)
  E3  Tier 0 PPV per area                       E4  pooled Tier 0 sensitivity
  E5  pooled Tier 0 specificity                 E6  exact match of the 7 Tier 0 area labels of a trial
  E7  pooled curated v1.2 PPV on Tier 1-eligible (not development-linked) trials
  E7b pooled curated v1.2 PPV on all trials     (labelled OPTIMISTIC: development-linked trials included)
  E8  rule D agreement (keep or remove decision) among determinate diabetes-type references
  E9  rule K agreement (keep or remove decision) among determinate malignancy references
  E10 pooled Figure 2 row-label PPV (and per row)
  E11 pooled Figure 2 row-label sensitivity     (descriptive; not part of the precision plan)
Every estimand is design-weighted to the sampling frame recorded in the bundle (the 14,906 Figure 3 model
trials for the formal sample); unweighted sample counts are reported beside it and describe the sample only.

Usage (repository root on PYTHONPATH):
  python -m analysis.performance_analysis_v5 --manifest bundle_v5.manifest.json --out results_v5/ \\
      [--template clinical_review_results_template_v5.md] [--allow-synthetic] [--allow-pilot]

Who runs this: the investigator or designated analyst, after the formal phase is closed and the blinded reference is
locked; never during the review. Outputs are never overwritten: the run stops if a target file exists.

Repository adaptation (CivicSample Verify): imports the `analysis` package instead of `validation`, and
estimand_vectors treats a NaN rule label or subgroup answer (pandas 3 string columns) as absent, which is what
the original None check meant under pandas 2. Version 5.0.1 additionally enforces synthetic-identity marking,
valid sampling domains and trial identity consistency before analysis. No estimator or statistic is changed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

try:  # package import (repository root on sys.path)
    from analysis import agreement_metrics as am
    from analysis import performance_analysis_v3 as pa3
except ImportError:  # run from inside analysis/
    import agreement_metrics as am  # type: ignore
    import performance_analysis_v3 as pa3  # type: ignore

__version__ = "5.0.1"
EXPORT_FORMAT_VERSION_V5 = "5.0"
DB_SCHEMA_VERSION_V5 = "5.0.0"

# ---------------------------------------------------------------------------
# Codes (identical to migrations/0004_v5_trial_label_verification.sql)
# ---------------------------------------------------------------------------
AREA_KEYS = ["ONCOLOGY", "CARDIOVASCULAR", "MENTAL_HEALTH", "INFECTIOUS", "METABOLIC", "NEUROLOGICAL", "RESPIRATORY"]
AREA_ITEMS = [f"AREA_{a}" for a in AREA_KEYS]
ROW_KEYS = ["CAN_ALL", "DIAB", "DEP", "OBE", "AST", "COPD", "COV", "SCZ", "HTN", "PAIN"]
ROW_ITEMS = [f"FIG2_ROW_{r}" for r in ROW_KEYS]
SG_ITEMS = ["SG_DIABETES_TYPE", "SG_NEOPLASM_MALIGNANCY"]
REVIEWER_ITEMS = AREA_ITEMS + ROW_ITEMS + SG_ITEMS            # 19 items per trial
REQUIRED_LABEL_ITEMS = AREA_ITEMS + ROW_ITEMS                 # 17 frozen labels per trial
RULE_ITEMS = ["RULE_D", "RULE_K"]                             # frozen only where the rule applied
SG_ROW = {"SG_DIABETES_TYPE": "FIG2_ROW_DIAB", "SG_NEOPLASM_MALIGNANCY": "FIG2_ROW_CAN_ALL"}
SG_RULE = {"SG_DIABETES_TYPE": "RULE_D", "SG_NEOPLASM_MALIGNANCY": "RULE_K"}
NOT_APPLICABLE = "NOT_APPLICABLE"


def item_family(item: str) -> str:
    if item in AREA_ITEMS:
        return "AREA"
    if item in ROW_ITEMS:
        return "FIG2_ROW"
    if item in SG_ITEMS or item in RULE_ITEMS:
        return item
    return "UNKNOWN"


SCALE = {
    "AREA": ["YES", "NO", "CONTEXT_DEPENDENT", "INSUFFICIENT_INFORMATION"],
    "FIG2_ROW": ["YES", "NO", "INSUFFICIENT_INFORMATION"],
    "SG_DIABETES_TYPE": ["TYPE_2", "TYPE_1", "BOTH_TYPE_1_AND_TYPE_2", "OTHER", "UNCLEAR"],
    "SG_NEOPLASM_MALIGNANCY": ["MALIGNANT", "NON_MALIGNANT", "UNCLEAR"],
}
DETAIL_CODES = {
    ("SG_DIABETES_TYPE", "OTHER"): ["PREDIABETES", "GESTATIONAL", "LADA_OR_AUTOIMMUNE", "MONOGENIC_OR_SECONDARY",
                                    "DIABETES_NOT_STUDIED", "OTHER_SPECIFIED"],
    ("SG_NEOPLASM_MALIGNANCY", "NON_MALIGNANT"): ["PRECANCEROUS", "BENIGN_NEOPLASM", "NOT_A_NEOPLASM", "OTHER_SPECIFIED"],
}
# Explicit "cannot tell" answers (state 2 of the three-state rule). Kept apart from unresolved (no reference)
# and from NOT_APPLICABLE (the item was not shown) in every count.
NONDIRECTIONAL = {"CONTEXT_DEPENDENT", "INSUFFICIENT_INFORMATION", "UNCLEAR"}
RULE_D_DECISION = {"D1_KEEP_TYPE2": "KEEP", "D4A_KEEP_UNRESOLVED_PARENT_ONLY": "KEEP",
                   "D4B_KEEP_UNRESOLVED_COMPLICATION_ONLY": "KEEP", "D2_REMOVE_OTHER_TYPE": "REMOVE",
                   "D3_REMOVE_PREDIABETES_ONLY": "REMOVE"}
RULE_K_DECISION = {"K_KEEP_MALIGNANT_COMPATIBLE": "KEEP", "K_KEEP_HEURISTIC_NONMALIGNANT_CLASS": "KEEP",
                   "K_REMOVE_VERIFIED_NONMALIGNANT": "REMOVE"}
# Clinician answer -> the decision a correct rule would have made (UNCLEAR is indeterminate)
SG_DECISION = {"SG_DIABETES_TYPE": {"TYPE_2": "KEEP", "BOTH_TYPE_1_AND_TYPE_2": "KEEP", "TYPE_1": "REMOVE", "OTHER": "REMOVE"},
               "SG_NEOPLASM_MALIGNANCY": {"MALIGNANT": "KEEP", "NON_MALIGNANT": "REMOVE"}}
REFERENCE_STATUSES = ["CONCORDANT_ADOPTED_BY_RULE", "CONCORDANT_CONFIRMED", "CONCORDANT_REVISED", "DISCORDANT_RESOLVED",
                      "SINGLE_REVIEW_ADJUDICATED", "UNRESOLVED_ESCALATED", "NOT_APPLICABLE_BY_RULE", "NOT_REVIEWED"]
RULE_STATUSES = {"CONCORDANT_ADOPTED_BY_RULE", "NOT_APPLICABLE_BY_RULE", "NOT_REVIEWED"}
ADJUDICATION_BASES = ["REVIEWER_1", "REVIEWER_2", "BOTH_REVIEWERS", "NEITHER", "NONE"]
DISAGREEMENT_REASONS = list(pa3.DISAGREEMENT_REASONS)   # the v3 list, unchanged (0004 uses the same list)
ADJUDICATION_SCOPES = {"DISAGREEMENTS_ONLY", "ALL_ITEMS"}
RECORD_CATEGORY = {"FORMAL": "LABEL_VERIFICATION_FORMAL", "PILOT": "SYNTHETIC_PILOT"}
FORMAL_ID = re.compile(r"^TLV5-\d{3}$")
SYNTHETIC_FORMAL_ID = re.compile(r"^TLV5-TESTFX-\d{4}$")
PILOT_ID = re.compile(r"^SYN-")
MIN_UNITS_FOR_WEIGHTED = pa3.MIN_UNITS_FOR_WEIGHTED     # 10, prespecified in v3

DENOMINATOR_RULES_V5 = {
    "R0_primary": "reference CONTEXT_DEPENDENT, INSUFFICIENT_INFORMATION (or UNCLEAR for subgroup items) and "
                  "unresolved items are excluded from the binary metrics and counted by reason",
    "R1_bound_nondirectional_as_yes": "reference CONTEXT_DEPENDENT or INSUFFICIENT_INFORMATION treated as YES "
                                      "(unresolved still excluded); the v3 rule R1_bound_nondirectional_as_include",
    "R2_bound_nondirectional_as_no": "reference CONTEXT_DEPENDENT or INSUFFICIENT_INFORMATION treated as NO "
                                     "(unresolved still excluded); the v3 rule R2_bound_nondirectional_as_exclude",
}

# ---------------------------------------------------------------------------
# Export contract (column names are those of the three v5 export views)
# ---------------------------------------------------------------------------
JUDGMENT_COLUMNS_V5 = ["record_category", "case_id", "mode", "nct_id", "item_family", "item_code", "reviewer_slot",
                       "reviewer_pseudo_id", "answer_initial", "answer_effective_preclose", "detail_initial",
                       "detail_effective", "n_revisions_preclose", "uncertain", "packet_issue_flag",
                       "first_submitted_at", "last_submitted_at"]
REFERENCE_COLUMNS_V5 = ["record_category", "case_id", "mode", "item_family", "item_code", "adjudication_id",
                        "reference_answer", "reference_detail", "adjudication_status", "adjudication_basis",
                        "n_reviewers_submitted", "n_reviewer_answers", "disagreement_reason_code", "adjudicator_pseudo_id",
                        "adjudicator_role", "adjudication_blinded", "post_unblinding_revision_exists", "adjudicated_at",
                        "reference_lock_id"]
LABEL_COLUMNS_V5 = ["label_set_id", "record_category", "case_id", "mode", "nct_id", "item_family", "item_code",
                    "label_primary", "label_secondary", "label_informational", "dev_linked_area", "label_frozen_at",
                    "frame", "stratum", "variance_stratum", "frame_stratum_size", "n_sampled_in_stratum",
                    "selection_probability", "sampling_weight", "dev_linked", "tier1_eligible", "design_version"]
FILE_COLUMNS = {"independent_judgments": JUDGMENT_COLUMNS_V5, "adjudicated_reference": REFERENCE_COLUMNS_V5,
                "frozen_labels": LABEL_COLUMNS_V5}
MANIFEST_KEYS_V5 = ["export_id", "export_format_version", "mode", "created_at", "app_git_sha", "db_schema_version",
                    "is_synthetic_fixture", "design_version", "adjudication_scope", "label_set_id", "frozen_at",
                    "frozen_case_list_sha256", "frozen_label_rows_sha256", "formal_phase_opened_at",
                    "formal_phase_closed_at", "formal_phase_status", "snapshot_taken_at", "snapshot_sha256",
                    "snapshot_rows", "reference_locked", "reference_lock_id", "reference_locked_at", "rubric_version",
                    "rubric_sha256", "files"]
FILE_ROLES = set(FILE_COLUMNS)


class ExportError(pa3.ExportError):
    """The v5 bundle breaks the contract. Nothing is computed."""


class MissingResultError(pa3.MissingResultError):
    """A manuscript slot has no computed value. The block is not written."""


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def _blank(x: Any) -> bool:
    return x is None or (isinstance(x, float) and np.isnan(x)) or str(x).strip() == ""


def _s(x: Any) -> Optional[str]:
    return None if _blank(x) else str(x)


def _ts(x: Any, what: str) -> pd.Timestamp:
    t = pd.to_datetime(x, utc=True, errors="coerce")
    if pd.isna(t):
        raise ExportError(f"{what} is not a timestamp: {x!r}")
    return t


def _ts_col(s: pd.Series, name: str) -> pd.Series:
    t = pd.to_datetime(s, utc=True, errors="coerce")
    if t.isna().any():
        raise ExportError(f"{name} has missing or unreadable timestamps")
    return t


def _bool(x: Any) -> Optional[bool]:
    return pa3._as_bool(x)


def judgments_snapshot_sha256(J: pd.DataFrame) -> str:
    """Recompute the hash the database stored at the close (private.tlv5_judgments_text, migration 0011):
    one line per judgment row, fields joined by '|', a missing detail code as '', the uncertainty flag as
    true/false, timestamps exactly as exported, ordered by case_id and item_code in byte order, then slot."""
    lines = []
    for r in J.itertuples(index=False):
        u = pa3._as_bool(r.uncertain)
        if u is None:
            raise ExportError("uncertain must be an explicit boolean for every submitted judgment")
        lines.append((str(r.case_id).encode("utf-8"), str(r.item_code).encode("utf-8"), int(r.reviewer_slot), "|".join([
            str(r.case_id), str(r.item_code), str(int(r.reviewer_slot)), str(r.reviewer_pseudo_id), str(r.answer_initial),
            str(r.answer_effective_preclose), _s(r.detail_initial) or "", _s(r.detail_effective) or "",
            str(int(r.n_revisions_preclose)), "true" if u else "false", str(r.first_submitted_at), str(r.last_submitted_at)])))
    lines.sort(key=lambda t: (t[0], t[1], t[2]))
    return hashlib.sha256("\n".join(t[3] for t in lines).encode("utf-8")).hexdigest()


def case_list_sha256(case_ids: Sequence[str]) -> str:
    """SHA-256 of the sorted, LF-joined case IDs (code-point order); the freeze records this value."""
    return hashlib.sha256("\n".join(sorted(map(str, case_ids))).encode("utf-8")).hexdigest()


def label_row_text(label_set_id: str, case_id: str, item_code: str, primary: Any, secondary: Any, informational: Any) -> str:
    """Canonical text of one frozen label row (scripts/03_draw_sample_v5.py and private.tlv5_label_row_text)."""
    return "|".join([str(label_set_id), str(case_id), str(item_code), str(primary), _s(secondary) or "", _s(informational) or ""])


def label_rows_sha256(labels: pd.DataFrame) -> str:
    """SHA-256 of the row hashes joined by LF, rows ordered by case_id then item_code (code-point order)."""
    rows = sorted(((str(r.case_id), str(r.item_code),
                    hashlib.sha256(label_row_text(r.label_set_id, r.case_id, r.item_code, r.label_primary, r.label_secondary,
                                                  r.label_informational).encode("utf-8")).hexdigest())
                   for r in labels.itertuples(index=False)))
    return hashlib.sha256("\n".join(h for _, _, h in rows).encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

def load_bundle(manifest_path: str) -> Tuple[Dict[str, pd.DataFrame], Dict[str, Any]]:
    """Read the manifest and its three files; verify presence, SHA-256 and row counts."""
    mp = Path(manifest_path)
    manifest = json.loads(mp.read_text(encoding="utf-8"))
    missing = [k for k in MANIFEST_KEYS_V5 if k not in manifest]
    if missing:
        raise ExportError(f"manifest lacks required v5 keys: {missing}")
    files = {f["role"]: f for f in manifest["files"]}
    if set(files) != FILE_ROLES or len(manifest["files"]) != len(FILE_ROLES):
        raise ExportError(f"manifest must list exactly one file for each role {sorted(FILE_ROLES)}")
    data: Dict[str, pd.DataFrame] = {}
    for role, f in files.items():
        p = mp.parent / f["name"]
        if not p.exists():
            raise ExportError(f"{role} file {f['name']} is missing")
        got = pa3._sha256(p)
        if got != f["sha256"]:
            raise ExportError(f"SHA-256 mismatch for {f['name']}: manifest {f['sha256']}, file {got}")
        df = pd.read_csv(p, dtype=str, keep_default_na=False, na_values=[""])
        if int(f["rows"]) != len(df):
            raise ExportError(f"row count {len(df)} of {f['name']} differs from manifest {f['rows']}")
        data[role] = df
    return data, manifest


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _check_manifest(manifest: Mapping[str, Any], allow_synthetic: bool, allow_pilot: bool) -> None:
    if str(manifest["export_format_version"]) != EXPORT_FORMAT_VERSION_V5:
        raise ExportError(f"export_format_version {manifest['export_format_version']!r} is not {EXPORT_FORMAT_VERSION_V5}")
    if str(manifest["db_schema_version"]) != DB_SCHEMA_VERSION_V5:
        raise ExportError(f"db_schema_version {manifest['db_schema_version']!r} is not {DB_SCHEMA_VERSION_V5}")
    if manifest["mode"] not in RECORD_CATEGORY:
        raise ExportError("mode must be FORMAL (or PILOT for the pilot dry run); calibration data never enter any statistic")
    if manifest["mode"] == "PILOT" and not allow_pilot:
        raise ExportError("a PILOT bundle is analysed only as a pipeline dry run; pass allow_pilot=True")
    try:
        synthetic = _bool(manifest["is_synthetic_fixture"])
    except pa3.ExportError as error:
        raise ExportError("is_synthetic_fixture must be an explicit boolean") from error
    if synthetic is None:
        raise ExportError("is_synthetic_fixture must be an explicit boolean")
    if synthetic and not allow_synthetic:
        raise ExportError("manifest marks a synthetic fixture; pass allow_synthetic=True only in tests")
    if _bool(manifest["reference_locked"]) is not True:
        raise ExportError("the blinded adjudicated reference is not locked; accuracy is not computed before the lock")
    if manifest["adjudication_scope"] not in ADJUDICATION_SCOPES:
        raise ExportError(f"adjudication_scope must be one of {sorted(ADJUDICATION_SCOPES)}")
    if manifest["mode"] == "FORMAL" and manifest["formal_phase_status"] not in ("CLOSED_COMPLETE", "CLOSED_INCOMPLETE"):
        raise ExportError("a FORMAL bundle needs formal_phase_status CLOSED_COMPLETE or CLOSED_INCOMPLETE")
    for k in ("frozen_case_list_sha256", "frozen_label_rows_sha256"):
        if not re.fullmatch(r"[0-9a-f]{64}", str(manifest[k])):
            raise ExportError(f"{k} is not a SHA-256 value")
    if manifest["mode"] == "FORMAL" and not re.fullmatch(r"[0-9a-f]{64}", str(manifest["snapshot_sha256"])):
        raise ExportError("a FORMAL bundle needs the independent-judgment snapshot hash")


def _check_ids(nm: str, df: pd.DataFrame, mode: str, allow_synthetic: bool,
               is_synthetic_fixture: bool) -> None:
    if set(df["mode"].astype(str)) != {mode}:
        raise ExportError(f"{nm}: every row must carry mode {mode}")
    if set(df.record_category.astype(str)) != {RECORD_CATEGORY[mode]}:
        raise ExportError(f"{nm}: every row must carry record category {RECORD_CATEGORY[mode]}")
    ids = df.case_id.astype(str)
    if ids.str.startswith("CAL5-").any():
        raise ExportError(f"{nm}: calibration cases (CAL5-) never enter any statistic")
    if mode == "PILOT":
        if not ids.map(lambda x: bool(PILOT_ID.match(x))).all():
            raise ExportError(f"{nm}: PILOT case IDs carry the SYN- prefix")
        return
    real = ids.map(lambda x: bool(FORMAL_ID.match(x)))
    synth = ids.map(lambda x: bool(SYNTHETIC_FORMAL_ID.match(x)))
    if synth.any() and not allow_synthetic:
        raise ExportError(f"{nm}: synthetic fixture case IDs found; not study data")
    if not (real | synth).all():
        raise ExportError(f"{nm}: a FORMAL case ID is not of the form TLV5-nnn")
    if real.any() and synth.any():
        raise ExportError(f"{nm}: real and synthetic formal case IDs cannot be mixed")
    if len(ids) and bool(synth.all()) != is_synthetic_fixture:
        raise ExportError(f"{nm}: case IDs contradict is_synthetic_fixture in the manifest")


def validate_bundle(data: Mapping[str, pd.DataFrame], manifest: Mapping[str, Any], allow_synthetic: bool = False,
                    allow_pilot: bool = False) -> Tuple[Dict[str, pd.DataFrame], List[str]]:
    """Apply every v5 rule. Raises ExportError on any breach; nothing is filtered silently.

    Returns ({'judgments', 'reference', 'labels', 'cases'}, passed): typed copies of the three files plus one
    row per case with its design fields; passed lists the checks that passed, in order.
    """
    passed: List[str] = []
    _check_manifest(manifest, allow_synthetic, allow_pilot)
    mode = manifest["mode"]
    passed.append(f"manifest: format 5.0, schema 5.0.0, mode {mode}, reference locked, scope {manifest['adjudication_scope']}")

    J = data["independent_judgments"].copy()
    A = data["adjudicated_reference"].copy()
    L = data["frozen_labels"].copy()
    for nm, df in (("independent_judgments", J), ("adjudicated_reference", A), ("frozen_labels", L)):
        cols = FILE_COLUMNS[nm]
        miss = [c for c in cols if c not in df.columns]
        extra = [c for c in df.columns if c not in cols]
        if miss or extra:
            raise ExportError(f"{nm}: columns differ from the v5 contract (missing {miss}, unexpected {extra})")
        _check_ids(nm, df, mode, allow_synthetic, _bool(manifest["is_synthetic_fixture"]) is True)
        fam = df.item_code.map(item_family)
        if (fam == "UNKNOWN").any() or (fam != df.item_family).any():
            raise ExportError(f"{nm}: unknown item codes or item_family values that do not match the item code")
    passed.append("columns and identifiers: exact v5 columns; one mode and record category; no CAL5- case; ID patterns hold")

    # ---- frozen labels and design ----------------------------------------------------------------
    if L.duplicated(["case_id", "item_code"]).any():
        raise ExportError("frozen_labels: more than one label for a case x item")
    if set(L.label_set_id) != {manifest["label_set_id"]}:
        raise ExportError(f"frozen_labels: label set {sorted(set(L.label_set_id))} is not the frozen set {manifest['label_set_id']}")
    if not set(L.item_code) <= set(REQUIRED_LABEL_ITEMS + RULE_ITEMS):
        raise ExportError("frozen_labels: subgroup items are reviewer items and are never frozen labels")
    cases = sorted(set(L.case_id))
    have = set(zip(L.case_id, L.item_code))
    lacking = [(c, i) for c in cases for i in REQUIRED_LABEL_ITEMS if (c, i) not in have]
    if lacking:
        raise ExportError(f"frozen_labels: {len(lacking)} required area or row labels are missing, e.g. {lacking[:3]}")
    fam = L.item_code.map(item_family)
    ok_bin = L.label_primary.isin(["YES", "NO"])
    if not ok_bin[fam.isin(["AREA", "FIG2_ROW"])].all():
        raise ExportError("frozen_labels: area and row labels are YES or NO")
    if not L.loc[fam == "AREA", "label_secondary"].isin(["YES", "NO"]).all():
        raise ExportError("frozen_labels: every area label carries the curated v1.2 (secondary) label")
    if not L.loc[fam == "RULE_D", "label_primary"].isin(list(RULE_D_DECISION)).all() or \
            not L.loc[fam == "RULE_K", "label_primary"].isin(list(RULE_K_DECISION)).all():
        raise ExportError("frozen_labels: unknown rule D or rule K outcome")
    if label_rows_sha256(L) != manifest["frozen_label_rows_sha256"]:
        raise ExportError("frozen labels differ from the label set hashed at the freeze "
                          "(an ontology, mapping or rule change after the freeze cannot alter the labels evaluated)")
    if case_list_sha256(cases) != manifest["frozen_case_list_sha256"]:
        raise ExportError("case list does not match the frozen case list (a case was added, dropped or renamed after the freeze)")
    frozen_at = _ts(manifest["frozen_at"], "frozen_at")
    if (_ts_col(L.label_frozen_at, "label_frozen_at") > frozen_at).any():
        raise ExportError("a label was recorded after the freeze")
    design_cols = ["nct_id", "frame", "stratum", "variance_stratum", "frame_stratum_size", "n_sampled_in_stratum",
                   "selection_probability", "sampling_weight", "dev_linked", "tier1_eligible", "design_version"]
    if (L.groupby("case_id")[design_cols].nunique(dropna=False) > 1).any().any():
        raise ExportError("frozen_labels: design fields differ between the label rows of one case")
    C = L.drop_duplicates("case_id")[["case_id"] + design_cols].copy().set_index("case_id").sort_index()
    for c in ("nct_id", "frame", "stratum", "variance_stratum", "design_version"):
        if C[c].map(_blank).any():
            raise ExportError(f"frozen_labels: {c} is required for every case")
    if C.nct_id.duplicated().any():
        raise ExportError("frozen_labels: one trial cannot appear under multiple case IDs")
    for c in ("frame_stratum_size", "n_sampled_in_stratum"):
        C[c] = pd.to_numeric(C[c], errors="coerce")
    for c in ("selection_probability", "sampling_weight"):
        C[c] = pd.to_numeric(C[c], errors="coerce").astype(float)
    C["dev_linked"] = C.dev_linked.map(_bool)
    C["tier1_eligible"] = C.tier1_eligible.map(_bool)
    if C[["dev_linked", "tier1_eligible"]].isna().any().any():
        raise ExportError("frozen_labels: development and eligibility flags must be explicit booleans")
    numbers = C[["frame_stratum_size", "n_sampled_in_stratum", "selection_probability", "sampling_weight"]]
    if not np.isfinite(numbers.to_numpy(dtype=float)).all():
        raise ExportError("frozen_labels: design numbers must be finite and readable")
    for c in ("frame_stratum_size", "n_sampled_in_stratum"):
        if ((C[c] <= 0) | (C[c] % 1 != 0)).any():
            raise ExportError(f"frozen_labels: {c} must be a positive integer")
    if (C.n_sampled_in_stratum > C.frame_stratum_size).any():
        raise ExportError("frozen_labels: sampled count cannot exceed the frame stratum size")
    if ((C.selection_probability <= 0) | (C.selection_probability > 1)).any():
        raise ExportError("frozen_labels: selection_probability must be greater than zero and at most one")
    if (C.sampling_weight < 1).any():
        raise ExportError("frozen_labels: sampling_weight must be at least one")
    if not np.allclose(C.sampling_weight * C.selection_probability, 1.0, rtol=1e-9, atol=1e-9):
        raise ExportError("sampling_weight must equal 1 / selection_probability for every case")
    if not np.allclose(C.selection_probability, C.n_sampled_in_stratum / C.frame_stratum_size, rtol=1e-9, atol=1e-12):
        raise ExportError("selection_probability must equal n_sampled_in_stratum / frame_stratum_size")
    g = C.groupby("variance_stratum")
    if (g.frame_stratum_size.nunique() > 1).any() or (g.n_sampled_in_stratum.nunique() > 1).any():
        raise ExportError("frame_stratum_size and n_sampled_in_stratum must be constant within a variance stratum")
    if (g.size() != g.n_sampled_in_stratum.first()).any():
        raise ExportError("the number of cases per stratum differs from n_sampled_in_stratum (a sampled case is missing)")
    if (C.tier1_eligible == C.dev_linked).any():
        raise ExportError("tier1_eligible must be the complement of dev_linked")
    if set(C.frame) != {C.frame.iloc[0]} or len(set(C.design_version)) != 1:
        raise ExportError("one frame and one design version per bundle")
    if C.design_version.iloc[0] != manifest["design_version"]:
        raise ExportError("design_version differs between the labels and the manifest")
    passed.append("frozen labels: one frozen set, 17 area and row labels per case, label-set and case-list hashes equal the "
                  "freeze, recorded before the freeze; weight = 1 / probability = N_h / n_h; tier1_eligible = not dev_linked")

    # ---- independent judgments ---------------------------------------------------------------------
    if not set(J.case_id) <= set(cases):
        raise ExportError("independent_judgments: a case without frozen labels")
    if not J.nct_id.eq(J.case_id.map(C.nct_id)).all():
        raise ExportError("independent_judgments: trial identifiers differ from the frozen labels")
    if not set(J.reviewer_slot.astype(str)) <= {"1", "2"}:
        raise ExportError("reviewer_slot must be 1 or 2")
    J["reviewer_slot"] = J.reviewer_slot.astype(int)
    if J.duplicated(["case_id", "item_code", "reviewer_slot"]).any():
        raise ExportError("independent_judgments: duplicate case x item x reviewer slot rows")
    per = J.groupby(["case_id", "reviewer_slot"]).item_code.apply(set)
    if not per.map(lambda s: s == set(REVIEWER_ITEMS)).all():
        raise ExportError("independent_judgments: every reviewer with a submission has all 19 items (NOT_APPLICABLE included)")
    g = J.groupby("case_id")
    if (g.reviewer_pseudo_id.nunique() != g.reviewer_slot.nunique()).any():
        raise ExportError("the two judgments of a case must come from two different reviewers")
    if (J.groupby("reviewer_pseudo_id").reviewer_slot.nunique() > 1).any():
        raise ExportError("a reviewer keeps one slot for every case")
    fam = J.item_code.map(item_family)
    for c in ("answer_initial", "answer_effective_preclose"):
        if J[c].isna().any():
            raise ExportError(f"{c} is blank in a judgment row (NOT_APPLICABLE is written out, never blank)")
        ok = np.array([a in SCALE[f] or (a == NOT_APPLICABLE and f in SG_ITEMS) for a, f in zip(J[c], fam)])
        if not ok.all():
            raise ExportError(f"{c} has codes outside the item scale (area and row items are never NOT_APPLICABLE)")
    for a_col, d_col in (("answer_initial", "detail_initial"), ("answer_effective_preclose", "detail_effective")):
        for r in J.itertuples(index=False):
            allowed = DETAIL_CODES.get((r.item_code, getattr(r, a_col)))
            d = _s(getattr(r, d_col))
            if (allowed is None and d is not None) or (allowed is not None and d not in allowed):
                raise ExportError(f"{d_col} does not fit the answer for {r.case_id} {r.item_code}")
    # subgroup display rule: shown exactly when the reviewer's own row answer is YES
    eff = J.set_index(["case_id", "reviewer_slot", "item_code"]).answer_effective_preclose
    ini = J.set_index(["case_id", "reviewer_slot", "item_code"]).answer_initial
    for sg, row in SG_ROW.items():
        for s in (eff, ini):
            shown = s.xs(sg, level="item_code") != NOT_APPLICABLE
            yes = s.xs(row, level="item_code") == "YES"
            if not (shown.sort_index() == yes.reindex(shown.index).sort_index()).all():
                raise ExportError(f"{sg} must be answered exactly when the same reviewer answered {row} YES")
    nrev = pd.to_numeric(J.n_revisions_preclose, errors="coerce")
    if nrev.isna().any() or (nrev < 0).any():
        raise ExportError("n_revisions_preclose must be a non-negative integer")
    J["n_revisions_preclose"] = nrev.astype(int)
    changed = (J.answer_initial != J.answer_effective_preclose)
    if (changed & (J.n_revisions_preclose == 0)).any():
        raise ExportError("a judgment changed between the initial and effective answer but records no revision")
    J["uncertain"] = J.uncertain.map(_bool)
    J["packet_issue_flag"] = J.packet_issue_flag.map(_bool)
    for c in ("uncertain", "packet_issue_flag"):
        if J[c].isna().any():
            raise ExportError(f"{c} must be an explicit boolean for every submitted judgment")
    jf, jl = _ts_col(J.first_submitted_at, "first_submitted_at"), _ts_col(J.last_submitted_at, "last_submitted_at")
    if mode == "FORMAL":
        opened, closed = _ts(manifest["formal_phase_opened_at"], "formal_phase_opened_at"), _ts(manifest["formal_phase_closed_at"], "formal_phase_closed_at")
        if opened < frozen_at:
            raise ExportError("the formal phase opened before the freeze")
        if (jf < opened).any() or (jl > closed).any() or (jl < jf).any():
            raise ExportError("an independent judgment falls outside the formal phase (before the opening or after the close)")
        if int(manifest["snapshot_rows"]) != len(J):
            raise ExportError("the judgment file row count differs from the snapshot taken at the close")
        if judgments_snapshot_sha256(J) != str(manifest["snapshot_sha256"]):
            raise ExportError("the judgment rows do not reproduce snapshot_sha256: the independent judgments changed after the "
                              "snapshot taken at the close, or the bundle was assembled from other rows")
    passed.append("independent judgments: 19 items per reviewer and case, item scales and detail codes, subgroup items shown "
                  "exactly after a YES row answer, two different reviewers, revisions recorded, inside the formal phase")

    # ---- adjudicated reference ----------------------------------------------------------------------
    if A.duplicated(["case_id", "item_code"]).any():
        raise ExportError("adjudicated_reference: more than one reference row per case x item")
    if set(zip(A.case_id, A.item_code)) != {(c, i) for c in cases for i in REVIEWER_ITEMS}:
        raise ExportError("adjudicated_reference: one row per case x reviewer item is required (19 per case)")
    for c in ("adjudication_blinded", "post_unblinding_revision_exists"):
        A[c] = A[c].map(_bool)
    for c in ("n_reviewers_submitted", "n_reviewer_answers"):
        A[c] = pd.to_numeric(A[c], errors="coerce").astype("Int64")
    bad = set(A.adjudication_status.astype(str)) - set(REFERENCE_STATUSES)
    if bad:
        raise ExportError(f"unknown adjudication_status values: {sorted(bad)}")
    bad = set(A.adjudication_basis.astype(str)) - set(ADJUDICATION_BASES)
    if bad:
        raise ExportError(f"unknown adjudication_basis values: {sorted(bad)}")
    bad = set(A.disagreement_reason_code.dropna().astype(str)) - set(DISAGREEMENT_REASONS)
    if bad:
        raise ExportError(f"unknown disagreement reason codes: {sorted(bad)}")
    fam = A.item_code.map(item_family)
    st = A.adjudication_status
    ans = A.reference_answer
    blank_ok = st.isin(["UNRESOLVED_ESCALATED", "NOT_REVIEWED"])
    if (ans.isna() != blank_ok).any():
        raise ExportError("reference_answer is blank exactly when the status is UNRESOLVED_ESCALATED or NOT_REVIEWED")
    na_rule = st == "NOT_APPLICABLE_BY_RULE"
    if (na_rule & ~fam.isin(SG_ITEMS)).any() or (na_rule & (ans != NOT_APPLICABLE)).any():
        raise ExportError("NOT_APPLICABLE_BY_RULE applies to subgroup items only and carries the answer NOT_APPLICABLE")
    ok = np.array([_blank(a) or a in SCALE[f] or (a == NOT_APPLICABLE and f in SG_ITEMS) for a, f in zip(ans, fam)])
    if not ok.all():
        raise ExportError("reference_answer has codes outside the item scale (area and row items are never NOT_APPLICABLE)")
    for r in A.itertuples(index=False):
        allowed = DETAIL_CODES.get((r.item_code, r.reference_answer))
        d = _s(r.reference_detail)
        if (allowed is None and d is not None) or (allowed is not None and d not in allowed):
            raise ExportError(f"reference_detail does not fit the reference answer for {r.case_id} {r.item_code}")
    adj = ~st.isin(list(RULE_STATUSES))
    if mode == "FORMAL":
        if (A.adjudicator_role[adj] != "ADJUDICATOR").any():
            raise ExportError("every FORMAL adjudication is entered by the ADJUDICATOR role (an investigator never adjudicates)")
        if (A.adjudication_blinded[adj] != True).any():  # noqa: E712
            raise ExportError("the primary FORMAL reference includes an adjudication that was not blinded")
    if ((A.adjudicator_role[~adj] != "RULE") | (A.adjudicator_pseudo_id[~adj] != "RULE")).any():
        raise ExportError("rule rows, and only they, carry adjudicator RULE")
    if set(A.adjudicator_pseudo_id[adj].dropna()) & set(J.reviewer_pseudo_id):
        raise ExportError("an adjudicator also reviewed cases; the adjudicator must be a separate person")
    if manifest["adjudication_scope"] == "ALL_ITEMS" and (st == "CONCORDANT_ADOPTED_BY_RULE").any():
        raise ExportError("adjudication_scope ALL_ITEMS: every answered item needs an adjudicator decision, none by rule")
    if set(A.reference_lock_id.astype(str)) != {str(manifest["reference_lock_id"])}:
        raise ExportError("reference rows do not all belong to the manifest's reference lock")
    at = _ts_col(A.adjudicated_at, "adjudicated_at")
    lock_at = _ts(manifest["reference_locked_at"], "reference_locked_at")
    if mode == "FORMAL":
        closed = _ts(manifest["formal_phase_closed_at"], "formal_phase_closed_at")
        snap = _ts(manifest["snapshot_taken_at"], "snapshot_taken_at")
        if snap < closed:
            raise ExportError("the independent-judgment snapshot predates the close")
        if (at[adj] < snap).any() or (at > lock_at).any():
            raise ExportError("a primary adjudication falls outside the window between the snapshot and the reference lock")
    # agreement between the two files
    # concordance compares the answer AND the detail code (as the database does)
    jk = {(r.case_id, r.item_code, r.reviewer_slot): (r.answer_effective_preclose, _s(r.detail_effective))
          for r in J.itertuples(index=False)}
    nrev_case = J.groupby("case_id").reviewer_slot.nunique().reindex(cases).fillna(0).astype(int)
    for r in A.itertuples(index=False):
        answers = [jk.get((r.case_id, r.item_code, s)) for s in (1, 2)]
        answers = [a for a in answers if a is not None and a[0] != NOT_APPLICABLE]
        n_rev = int(nrev_case[r.case_id])
        if int(r.n_reviewers_submitted) != n_rev or int(r.n_reviewer_answers) != len(answers):
            raise ExportError(f"reference counts disagree with the judgments for {r.case_id} {r.item_code}")
        s = r.adjudication_status
        conc = len(answers) == 2 and answers[0] == answers[1]
        if s == "NOT_REVIEWED" and n_rev != 0:
            raise ExportError(f"NOT_REVIEWED is recorded for a reviewed case ({r.case_id})")
        if s == "NOT_APPLICABLE_BY_RULE" and (n_rev == 0 or answers):
            raise ExportError(f"NOT_APPLICABLE_BY_RULE needs a reviewed case and no reviewer answer ({r.case_id} {r.item_code})")
        if s == "CONCORDANT_ADOPTED_BY_RULE" and (not conc or (r.reference_answer, _s(r.reference_detail)) != answers[0]):
            raise ExportError(f"a rule reference differs from the reviewers' shared answer ({r.case_id} {r.item_code})")
        if s.startswith("CONCORDANT") and not conc:
            raise ExportError(f"a CONCORDANT status is recorded where the reviewers did not agree ({r.case_id} {r.item_code})")
        if s == "DISCORDANT_RESOLVED" and (len(answers) != 2 or conc or _blank(r.disagreement_reason_code)):
            raise ExportError(f"DISCORDANT_RESOLVED needs two different answers and a reason code ({r.case_id} {r.item_code})")
        if s == "SINGLE_REVIEW_ADJUDICATED" and len(answers) != 1:
            raise ExportError(f"SINGLE_REVIEW_ADJUDICATED needs exactly one reviewer answer ({r.case_id} {r.item_code})")
        if manifest["adjudication_scope"] == "DISAGREEMENTS_ONLY" and conc and s != "CONCORDANT_ADOPTED_BY_RULE" \
                and s != "UNRESOLVED_ESCALATED":
            raise ExportError("adjudication_scope DISAGREEMENTS_ONLY: concordant items enter the reference by rule only")
    passed.append("adjudicated reference: 19 rows per case; statuses, bases, reason codes and detail codes valid; three states "
                  "kept apart (answer, explicit unknown, NOT_APPLICABLE or unresolved); ADJUDICATOR only and blinded in FORMAL; "
                  "adjudicator distinct from reviewers; between the snapshot and the lock; consistent with the judgments and the scope")
    C["n_reviewers_submitted"] = nrev_case
    return {"judgments": J, "reference": A, "labels": L, "cases": C}, passed


# ---------------------------------------------------------------------------
# Trial-level analysis table
# ---------------------------------------------------------------------------

def _yd(answer: Optional[str], rule: str) -> Tuple[int, int]:
    """(Y, D): reference YES and determinate, under a denominator rule. Unresolved is never determinate."""
    if answer is None:
        return 0, 0
    if answer == "YES":
        return 1, 1
    if answer == "NO":
        return 0, 1
    if answer in NONDIRECTIONAL:
        if rule == "R1_bound_nondirectional_as_yes":
            return 1, 1
        if rule == "R2_bound_nondirectional_as_no":
            return 0, 1
        return 0, 0
    raise ExportError(f"unexpected area or row reference answer {answer!r}")


def trial_table(V: Mapping[str, pd.DataFrame], rule: str = "R0_primary") -> pd.DataFrame:
    """One row per REVIEWED case: design, frozen labels and reference indicators under one denominator rule."""
    if rule not in DENOMINATOR_RULES_V5:
        raise ValueError(f"unknown denominator rule {rule!r}")
    C, L, A = V["cases"], V["labels"], V["reference"]
    lab = L.set_index(["case_id", "item_code"])
    ref = A.set_index(["case_id", "item_code"])
    reviewed = C.index[C.n_reviewers_submitted > 0]
    rows = []
    for c in reviewed:
        d = C.loc[c]
        out: Dict[str, Any] = {"case_id": c, "variance_stratum": d.variance_stratum, "N_h": float(d.frame_stratum_size),
                               "dev_linked": bool(d.dev_linked), "tier1_eligible": bool(d.tier1_eligible),
                               "n_reviewers_submitted": int(d.n_reviewers_submitted)}
        for a in AREA_ITEMS:
            out[f"T0_{a}"] = int(lab.loc[(c, a), "label_primary"] == "YES")
            out[f"T1_{a}"] = int(lab.loc[(c, a), "label_secondary"] == "YES")
            out[f"Y_{a}"], out[f"D_{a}"] = _yd(_s(ref.loc[(c, a), "reference_answer"]), rule)
        for r in ROW_ITEMS:
            out[f"R_{r}"] = int(lab.loc[(c, r), "label_primary"] == "YES")
            out[f"Y_{r}"], out[f"D_{r}"] = _yd(_s(ref.loc[(c, r), "reference_answer"]), rule)
        for sg, rule_item in SG_RULE.items():
            out[rule_item] = _s(lab.loc[(c, rule_item), "label_primary"]) if (c, rule_item) in lab.index else None
            out[sg] = _s(ref.loc[(c, sg), "reference_answer"])
        rows.append(out)
    T = pd.DataFrame(rows).set_index("case_id")
    # within-stratum nonresponse adjustment: w = N_h / (reviewed cases in the stratum); equals the design weight
    # 1 / selection probability when every sampled case was reviewed
    n_resp = T.groupby("variance_stratum").size()
    T["weight"] = T.N_h / T.variance_stratum.map(n_resp)
    return T


def estimand_vectors(T: pd.DataFrame) -> Dict[str, Tuple[np.ndarray, np.ndarray]]:
    """Per-trial numerator and denominator for every estimand (same definitions as scripts/v5_design.estimand_vectors)."""
    T0 = T[[f"T0_{a}" for a in AREA_ITEMS]].to_numpy(bool)
    T1 = T[[f"T1_{a}" for a in AREA_ITEMS]].to_numpy(bool)
    Y = T[[f"Y_{a}" for a in AREA_ITEMS]].to_numpy(bool)
    D = T[[f"D_{a}" for a in AREA_ITEMS]].to_numpy(bool)
    R = T[[f"R_{r}" for r in ROW_ITEMS]].to_numpy(bool)
    YR = T[[f"Y_{r}" for r in ROW_ITEMS]].to_numpy(bool)
    DR = T[[f"D_{r}" for r in ROW_ITEMS]].to_numpy(bool)
    elig = T.tier1_eligible.to_numpy(bool)
    out: Dict[str, Tuple[np.ndarray, np.ndarray]] = {}
    out["E1_PPV_T0_POOLED"] = ((T0 & Y & D).sum(1), (T0 & D).sum(1))
    for j, a in enumerate(AREA_ITEMS):
        out[f"E3_PPV_T0_{a}"] = ((T0[:, j] & Y[:, j] & D[:, j]).astype(int), (T0[:, j] & D[:, j]).astype(int))
    out["E4_SENS_T0_POOLED"] = ((T0 & Y & D).sum(1), (Y & D).sum(1))
    out["E5_SPEC_T0_POOLED"] = ((~T0 & ~Y & D).sum(1), (~Y & D).sum(1))
    alld = D.all(1)
    out["E6_EXACT_MATCH_T0"] = (((T0 == Y).all(1) & alld).astype(int), alld.astype(int))
    out["E7_PPV_T1V12_POOLED_ELIGIBLE"] = ((T1 & Y & D).sum(1) * elig, (T1 & D).sum(1) * elig)
    out["E7b_PPV_T1V12_POOLED_ALL_OPTIMISTIC"] = ((T1 & Y & D).sum(1), (T1 & D).sum(1))
    for sg, rule_item, decision in (("SG_DIABETES_TYPE", "RULE_D", RULE_D_DECISION), ("SG_NEOPLASM_MALIGNANCY", "RULE_K", RULE_K_DECISION)):
        num, den = [], []
        for fr, rf in zip(T[rule_item], T[sg]):
            # pandas 3 stores a missing rule label or subgroup answer as NaN in a str column; treat it as absent
            fr = None if _blank(fr) else fr
            rf = None if _blank(rf) else rf
            clin = SG_DECISION[sg].get(rf) if rf is not None else None
            det = fr is not None and clin is not None
            den.append(int(det))
            num.append(int(det and decision[fr] == clin))
        key = "E8_RULE_D_AGREEMENT" if rule_item == "RULE_D" else "E9_RULE_K_AGREEMENT"
        out[key] = (np.array(num), np.array(den))
    out["E10_PPV_ROW_LABELS_POOLED"] = ((R & YR & DR).sum(1), (R & DR).sum(1))
    for j, r in enumerate(ROW_ITEMS):
        out[f"E10_PPV_ROW_{r}"] = ((R[:, j] & YR[:, j] & DR[:, j]).astype(int), (R[:, j] & DR[:, j]).astype(int))
    out["E11_SENS_ROW_LABELS_POOLED"] = ((R & YR & DR).sum(1), (YR & DR).sum(1))
    return out


ESTIMAND_TEXT = {
    "E1_PPV_T0_POOLED": "pooled Tier 0 PPV (trial-area pairs labelled YES; unit = trial)",
    "E4_SENS_T0_POOLED": "pooled Tier 0 sensitivity", "E5_SPEC_T0_POOLED": "pooled Tier 0 specificity",
    "E6_EXACT_MATCH_T0": "all 7 Tier 0 area labels of a trial match the reference (trials with 7 determinate answers)",
    "E7_PPV_T1V12_POOLED_ELIGIBLE": "pooled curated v1.2 PPV, Tier 1-eligible trials only (PROVISIONAL)",
    "E7b_PPV_T1V12_POOLED_ALL_OPTIMISTIC": "pooled curated v1.2 PPV, all trials (OPTIMISTIC: development-linked trials included)",
    "E8_RULE_D_AGREEMENT": "rule D keep/remove decision agrees with the clinician diabetes type (determinate answers)",
    "E9_RULE_K_AGREEMENT": "rule K keep/remove decision agrees with the clinician malignancy answer (determinate answers)",
    "E10_PPV_ROW_LABELS_POOLED": "pooled Figure 2 row-label PPV",
    "E11_SENS_ROW_LABELS_POOLED": "pooled Figure 2 row-label sensitivity (descriptive; not in the precision plan)",
}


def estimate(num: np.ndarray, den: np.ndarray, T: pd.DataFrame) -> Dict[str, Any]:
    """Design-weighted estimate (pa3.weighted_ratio_v3) plus the unweighted sample counts."""
    num = np.asarray(num, float)
    den = np.asarray(den, float)
    Nh = T.groupby("variance_stratum").N_h.first().to_dict()
    if (den > 0).sum() == 0:
        w = {"estimable": False, "estimate": float("nan"), "ci_low": float("nan"), "ci_high": float("nan"),
             "n_domain_unweighted": 0, "not_estimable_reason": "no unit in the domain"}
    else:
        w = pa3.weighted_ratio_v3(num, den, T.weight.to_numpy(float), T.variance_stratum.to_numpy(object), Nh)
    x, n = int(num.sum()), int(den.sum())
    unw = am.proportion(x, n) if n > 0 else {"x": 0, "n": 0, "estimate": float("nan"), "ci_low": float("nan"), "ci_high": float("nan")}
    unw["label"] = "unweighted sample counts (pairs treated as independent); describe the sample only"
    return {"design_weighted": w, "unweighted": unw}


def classifier_vs_reference(V: Mapping[str, pd.DataFrame], rule: str) -> Dict[str, Any]:
    T = trial_table(V, rule)
    vec = estimand_vectors(T)
    res = {k: dict(estimate(n, d, T), description=ESTIMAND_TEXT.get(k, k)) for k, (n, d) in vec.items()}
    return {"rule": rule, "rule_text": DENOMINATOR_RULES_V5[rule], "n_trials_reviewed": int(len(T)), "estimands": res}


# ---------------------------------------------------------------------------
# Reviewer consistency, subgroup cross-tabulations, flow and three-state accounting
# ---------------------------------------------------------------------------

def reviewer_consistency(V: Mapping[str, pd.DataFrame]) -> Dict[str, Any]:
    """Two-reviewer agreement per item, effective (primary) and initial answers. Consistency, never validation."""
    J = V["judgments"]
    out: Dict[str, Any] = {"label": "agreement between two clinicians is consistency, not validation"}
    for col in ("answer_effective_preclose", "answer_initial"):
        wide = J.pivot_table(index=["case_id", "item_code"], columns="reviewer_slot", values=col, aggfunc="first")
        if not {1, 2} <= set(wide.columns):
            out[col] = {"n_double_reviewed_cases": 0}
            continue
        wide = wide.dropna(subset=[1, 2]).reset_index()
        block: Dict[str, Any] = {"n_double_reviewed_cases": int(wide.case_id.nunique()), "items": {}, "families": {}}
        for item, g in wide.groupby("item_code"):
            fam = item_family(item)
            if fam in SG_ITEMS:
                g = g[(g[1] != NOT_APPLICABLE) & (g[2] != NOT_APPLICABLE)]      # shown to both reviewers
            if len(g) == 0:
                block["items"][item] = {"n_pairs": 0}
                continue
            k = am.cohen_kappa(g[1].tolist(), g[2].tolist(), SCALE[fam])
            block["items"][item] = {"n_pairs": int(len(g)), "raw_agreement": am.raw_agreement(g[1].tolist(), g[2].tolist()),
                                    "kappa": k["kappa"], "kappa_ci_low": k["ci_low"], "kappa_ci_high": k["ci_high"],
                                    "kappa_primary_recommended": k.get("kappa_primary_recommended")}
        for fam_name, items in (("AREA", AREA_ITEMS), ("FIG2_ROW", ROW_ITEMS)):
            g = wide[wide.item_code.isin(items)]
            block["families"][fam_name] = {"n_item_pairs": int(len(g)), "raw_agreement": am.raw_agreement(g[1].tolist(), g[2].tolist()),
                                           "note": "pooled over items within trials; descriptive only (pairs are not independent)"}
        out[col] = block
    return out


def subgroup_crosstabs(V: Mapping[str, pd.DataFrame]) -> Dict[str, Any]:
    """Frozen rule outcome x adjudicated subgroup answer (counts, unweighted, descriptive)."""
    L, A = V["labels"], V["reference"]
    out: Dict[str, Any] = {}
    for sg, rule_item in SG_RULE.items():
        fr = L[L.item_code == rule_item].set_index("case_id").label_primary
        rf = A[A.item_code == sg].set_index("case_id")
        tab = pd.DataFrame({"frozen": fr, "reference": rf.reference_answer.reindex(fr.index).fillna("UNRESOLVED_OR_NOT_REVIEWED")})
        out[rule_item] = {f"{a}|{b}": int(n) for (a, b), n in tab.value_counts().sort_index().items()}
    return out


def flow_and_states(V: Mapping[str, pd.DataFrame]) -> Dict[str, Any]:
    C, A, J = V["cases"], V["reference"], V["judgments"]
    fam = A.item_code.map(item_family)
    def state(r) -> str:
        a = _s(r.reference_answer)
        if r.adjudication_status == "NOT_REVIEWED":
            return "NOT_REVIEWED"
        if r.adjudication_status == "UNRESOLVED_ESCALATED":
            return "UNRESOLVED"
        if a == NOT_APPLICABLE:
            return "NOT_APPLICABLE_NOT_SHOWN"
        if a in NONDIRECTIONAL:
            return "EXPLICIT_INDETERMINATE"
        return "DETERMINATE_ANSWER"
    states = pd.Series([state(r) for r in A.itertuples(index=False)], index=A.index)
    by = pd.DataFrame({"family": fam, "state": states}).value_counts().sort_index()
    return {
        "cases_in_bundle": int(len(C)),
        "cases_reviewed_by_two": int((C.n_reviewers_submitted == 2).sum()),
        "cases_reviewed_by_one": int((C.n_reviewers_submitted == 1).sum()),
        "cases_not_reviewed": int((C.n_reviewers_submitted == 0).sum()),
        "independent_judgment_rows": int(len(J)),
        "reference_states_by_family": {f"{f}|{s}": int(n) for (f, s), n in by.items()},
        "adjudication_status_counts": A.adjudication_status.value_counts().sort_index().to_dict(),
        "disagreement_reason_counts": A.disagreement_reason_code.dropna().value_counts().sort_index().to_dict(),
        "judgments_marked_uncertain": int((J.uncertain == True).sum()),  # noqa: E712
        "cases_with_packet_issue_flag": int(J[J.packet_issue_flag == True].case_id.nunique()),  # noqa: E712
        "post_unblinding_revisions_flagged": int((A.post_unblinding_revision_exists == True).sum()),  # noqa: E712
        "dev_linked_cases": int((C.dev_linked == True).sum()),  # noqa: E712
        "tier1_eligible_cases": int((C.tier1_eligible == True).sum()),  # noqa: E712
        "strata": int(C.variance_stratum.nunique()),
        "frame": str(C.frame.iloc[0]),
        "frame_size_implied": float(C.groupby("variance_stratum").frame_stratum_size.first().sum()),
    }


def build_results(V: Mapping[str, pd.DataFrame], manifest: Mapping[str, Any], passed: List[str]) -> Dict[str, Any]:
    res: Dict[str, Any] = {
        "module_version": __version__, "performance_analysis_v3_version": pa3.__version__,
        "agreement_metrics_version": am.__version__, "export_format_version": EXPORT_FORMAT_VERSION_V5,
        "numpy_version": np.__version__, "pandas_version": pd.__version__,
        "export_id": manifest["export_id"], "mode": manifest["mode"], "design_version": manifest["design_version"],
        "label_set_id": manifest["label_set_id"], "frozen_case_list_sha256": manifest["frozen_case_list_sha256"],
        "frozen_label_rows_sha256": manifest["frozen_label_rows_sha256"], "snapshot_sha256": manifest["snapshot_sha256"],
        "reference_lock_id": manifest["reference_lock_id"], "adjudication_scope": manifest["adjudication_scope"],
        "is_synthetic_fixture": bool(_bool(manifest["is_synthetic_fixture"])), "is_pilot": manifest["mode"] == "PILOT",
        "integrity_checks_passed": passed,
        "labels": {
            "tier0": "Tier 0: parent MeSH category labels used in the analysis (deterministic, frozen)",
            "tier1": "Tier 1: curated v1.2 labels (PROVISIONAL [PENDING CLINICAL REVIEW]); estimates that include "
                     "development-linked trials are optimistic",
            "design_weighted": "design-weighted to the sampling frame (Hajek ratio, stratified linearization with finite "
                               "population correction, Wilson interval at the effective size capped at the domain count; "
                               "not estimable below 10 units); within-stratum nonresponse adjustment",
            "unweighted": "sample counts; describe the sample, not the frame",
            "agreement": "reviewer-reviewer agreement is consistency between two clinicians, not validation",
        },
        "flow": flow_and_states(V),
        "denominator_rules": DENOMINATOR_RULES_V5,
        "accuracy": {rule: classifier_vs_reference(V, rule) for rule in DENOMINATOR_RULES_V5},
        "reviewer_consistency": reviewer_consistency(V),
        "subgroup_crosstabs": subgroup_crosstabs(V),
        "not_estimable_by_design": [
            "curated v1.2 accuracy on Tier 1-eligible trials if fewer than 10 eligible label pairs exist (expected: "
            "few trials in the frame-based sample are not development-linked)",
            "per-area and per-row estimates whose domain has fewer than 10 sampled trials",
            "the labels on the 50,401 mixed-sex trials of the supplementary threshold models outside the sampling frame",
            "performance on pilot or calibration cases (never computed from formal data)",
        ],
    }
    return res


def estimates_table(res: Mapping[str, Any]) -> pd.DataFrame:
    rows = []
    for rule, block in res["accuracy"].items():
        for k, e in block["estimands"].items():
            w, u = e["design_weighted"], e["unweighted"]
            rows.append({"rule": rule, "estimand": k, "description": e["description"],
                         "estimable": bool(w.get("estimable", False)), "estimate_weighted": w.get("estimate"),
                         "ci_low_weighted": w.get("ci_low"), "ci_high_weighted": w.get("ci_high"),
                         "n_effective_capped": w.get("n_effective_capped"), "n_domain_trials": w.get("n_domain_unweighted"),
                         "not_estimable_reason": w.get("not_estimable_reason"), "x_unweighted": u.get("x"),
                         "n_unweighted": u.get("n"), "estimate_unweighted": u.get("estimate"),
                         "is_synthetic_fixture": res["is_synthetic_fixture"], "is_pilot": res["is_pilot"]})
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Manuscript block: fills {{SLOT}} markers from computed values only
# ---------------------------------------------------------------------------
R0 = "accuracy.R0_primary.estimands"
SLOT_MAP_V5: Dict[str, Tuple[str, str]] = {
    "N_CASES_SAMPLED": ("flow.cases_in_bundle", "int"),
    "N_CASES_TWO_REVIEWERS": ("flow.cases_reviewed_by_two", "int"),
    "N_CASES_ONE_REVIEWER": ("flow.cases_reviewed_by_one", "int"),
    "N_CASES_NOT_REVIEWED": ("flow.cases_not_reviewed", "int"),
    "PPV_T0_POOLED_W": (f"{R0}.E1_PPV_T0_POOLED.design_weighted", "est_ci_pct"),
    "SENS_T0_POOLED_W": (f"{R0}.E4_SENS_T0_POOLED.design_weighted", "est_ci_pct"),
    "SPEC_T0_POOLED_W": (f"{R0}.E5_SPEC_T0_POOLED.design_weighted", "est_ci_pct"),
    "EXACT_MATCH_T0_W": (f"{R0}.E6_EXACT_MATCH_T0.design_weighted", "est_ci_pct"),
    "PPV_ROWS_POOLED_W": (f"{R0}.E10_PPV_ROW_LABELS_POOLED.design_weighted", "est_ci_pct"),
    "RULE_D_AGREEMENT_W": (f"{R0}.E8_RULE_D_AGREEMENT.design_weighted", "est_ci_pct"),
    "RULE_K_AGREEMENT_W": (f"{R0}.E9_RULE_K_AGREEMENT.design_weighted", "est_ci_pct"),
    "RAW_AGREEMENT_AREA_ITEMS": ("reviewer_consistency.answer_effective_preclose.families.AREA.raw_agreement.estimate", "pct"),
    "RAW_AGREEMENT_AREA_ITEMS_CI": ("reviewer_consistency.answer_effective_preclose.families.AREA.raw_agreement", "ci_pct"),
}


def render_manuscript_block(results: Mapping[str, Any], template: str, allow_synthetic: bool = False) -> Tuple[str, pd.DataFrame]:
    """Fill {{SLOT}} markers from computed results only. Raises MissingResultError on any slot without a finite value."""
    if (results.get("is_synthetic_fixture") or results.get("is_pilot")) and not allow_synthetic:
        raise ExportError("results come from a synthetic fixture or a pilot bundle; refusing to render a manuscript block")
    slots = sorted(set(re.findall(r"\{\{([A-Z0-9_]+)\}\}", template)))
    trace, filled = [], template
    for slot in slots:
        if slot not in SLOT_MAP_V5:
            raise MissingResultError(f"template slot {slot} is not defined in SLOT_MAP_V5")
        path, kind = SLOT_MAP_V5[slot]
        text = pa3._format(kind, pa3._get(results, path))
        trace.append({"slot": slot, "results_path": path, "rendered": text})
        filled = filled.replace("{{" + slot + "}}", text)
    if re.search(r"\{\{[A-Z0-9_]+\}\}", filled):
        raise MissingResultError("unfilled slots remain")
    if results.get("is_synthetic_fixture") or results.get("is_pilot"):
        filled = "SYNTHETIC OR PILOT TEST OUTPUT. NOT STUDY RESULTS.\n\n" + filled
    return filled, pd.DataFrame(trace)


# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------

def run(manifest_path: str, allow_synthetic: bool = False, allow_pilot: bool = False) -> Dict[str, Any]:
    data, manifest = load_bundle(manifest_path)
    V, passed = validate_bundle(data, manifest, allow_synthetic, allow_pilot)
    return build_results(V, manifest, passed)


def _write_new(path: Path, write) -> None:
    if path.exists():
        raise FileExistsError(f"refusing to overwrite {path}; choose a new, empty --out folder")
    write(path)


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--template")
    ap.add_argument("--allow-synthetic", action="store_true")
    ap.add_argument("--allow-pilot", action="store_true")
    a = ap.parse_args(argv)
    res = run(a.manifest, a.allow_synthetic, a.allow_pilot)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    _write_new(out / "performance_results_v5.json",
               lambda p: p.write_text(json.dumps(pa3._jsonable(res), indent=2, sort_keys=True), encoding="utf-8"))
    _write_new(out / "performance_estimates_v5.csv", lambda p: estimates_table(res).to_csv(p, index=False))
    if a.template:
        block, trace = render_manuscript_block(res, Path(a.template).read_text(encoding="utf-8"), a.allow_synthetic)
        _write_new(out / "clinical_review_results_block_v5.md", lambda p: p.write_text(block, encoding="utf-8"))
        _write_new(out / "clinical_review_results_block_v5_trace.csv", lambda p: trace.to_csv(p, index=False))
    print(f"wrote {out / 'performance_results_v5.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
