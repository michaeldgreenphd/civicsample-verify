"""SYNTHETIC ENGINEERING ONLY. Proposed analysis; no clinical study results."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

import numpy as np
import pandas as pd

try:  # package import (repository root on sys.path)
    from analysis import agreement_metrics as am
    from analysis import performance_analysis_v3 as pa3
    from analysis import review_codes as rc
except ImportError:  # run from inside analysis/
    import agreement_metrics as am  # type: ignore
    import performance_analysis_v3 as pa3  # type: ignore
    import review_codes as rc  # type: ignore

__version__ = "4.0.3"
EXPORT_FORMAT_VERSION_V4 = "4.0"
POS, NEG = pa3.POS, pa3.NEG
L1_CODES = pa3.L1_CODES

# Record categories and their identifier prefixes (REVIEW_RUBRIC_v4.md, section "Record categories").
RECORD_PREFIX = {"HELDOUT_FORMAL": "HO4-", "HELDOUT_EXTENSION_APPROVED": "HO4R-", "DEVELOPMENT": "DEV4-",
                 "SYNTHETIC_PILOT": "SYN-", "RUBRIC_CALIBRATION": "CAL4-"}
NEVER_ANALYSED = {"DEVELOPMENT", "SYNTHETIC_PILOT", "RUBRIC_CALIBRATION", "HELDOUT_RESERVE_NOT_ADOPTED"}
NEVER_HELDOUT_PREFIXES = ("DEV4-", "CAL4-", "SYN-")
SYNTHETIC_CASE_MARK = "TESTFX"     # synthetic fixture case IDs look like HO4-TESTFX-0001
TIER1_VERSIONS = {"v1.1", "v1.2"}
LEVELS_V4 = {"DESCRIPTOR_LEVEL", "TRIAL_LEVEL", "DESCRIPTOR_LEVEL_IN_TRIAL_CASE"}
# v4 adds two adjudication statuses to the v3 list (review_codes.ADJUDICATION_STATUSES, unchanged):
#   CONCORDANT_ADOPTED_BY_RULE  both reviewers gave the same effective answer and, under the D2 scope
#                               DISAGREEMENTS_ONLY, that answer is the reference without adjudication
#                               (adjudicator_role CONCORDANCE_RULE, adjudicator_pseudo_id RULE);
#   SINGLE_REVIEW_ADJUDICATED   only one reviewer answered before the close; the adjudicator decided.
ADJUDICATION_STATUSES_V4 = list(rc.ADJUDICATION_STATUSES) + ["CONCORDANT_ADOPTED_BY_RULE", "SINGLE_REVIEW_ADJUDICATED"]
ADJUDICATION_SCOPES = {"DISAGREEMENTS_ONLY", "ALL_CASE_LEVELS"}
RULE_ADJUDICATOR = "RULE"

JUDGMENT_COLUMNS = ["export_id", "record_category", "case_id", "case_version", "review_module", "unit_type", "unit_id",
                    "nct_id", "descriptor_ui", "descriptor_name", "area", "determination_level", "reviewer_slot",
                    "reviewer_pseudo_id", "decision_initial", "decision_effective_preclose", "n_revisions_preclose",
                    "uncertain", "packet_issue_flag", "first_submitted_at", "last_submitted_at"]
ADJUDICATION_COLUMNS = ["export_id", "record_category", "case_id", "determination_level", "adjudication_id",
                        "adjudicated_decision", "adjudication_status", "adjudication_basis", "disagreement_reason_code",
                        "adjudicator_pseudo_id", "adjudicator_role", "adjudication_blinded",
                        "adjudicator_exposed_to_index_labels", "post_unblinding_revision_exists", "adjudicated_at",
                        "reference_lock_id"]
PREDICTION_COLUMNS = ["prediction_set_id", "record_category", "case_id", "frame_unit_id", "unit_type", "unit_id", "nct_id",
                      "descriptor_ui", "area", "determination_level", "tier0_binary", "tier1_version", "tier1_status_raw",
                      "tier1_binary", "stage_c_trial_status", "prediction_frozen_at", "selection_stratum",
                      "variance_stratum", "variance_stratum_size", "selection_probability", "sampling_weight",
                      "comparison_cell", "impact_tier", "policy_governed_neoplasm_GEN06", "provenance_audit_result"]
MANIFEST_KEYS_V4 = ["export_id", "export_type", "export_format_version", "mode", "review_module", "created_at",
                    "app_git_sha", "db_schema_version", "is_synthetic_fixture", "reference_locked", "reference_lock_id",
                    "reference_locked_at", "formal_phase_opened_at", "formal_phase_closed_at", "freeze_manifest_id",
                    "freeze_manifest_sha256", "frozen_at", "frozen_sample_case_list_sha256", "frozen_prediction_set_sha256",
                    "tier1_version_frozen", "ontology_version", "ontology_sha256", "tier1_decision_file_sha256",
                    "tier0_mapping_sha256", "rubric_version", "rubric_sha256", "sampling_design_version",
                    "provenance_audit_sha256", "extension_approved_by_amendment", "amendment_id", "adjudication_scope", "files"]
FILE_ROLES = {"independent_judgments", "adjudicated_reference", "frozen_predictions"}


class ExportError(pa3.ExportError):
    """The v4 bundle breaks the contract. Nothing is computed."""


def case_list_sha256(case_ids) -> str:
    """SHA-256 of the sorted, LF-joined case IDs. The freeze records this value for the frozen sample."""
    return hashlib.sha256("\n".join(sorted(map(str, case_ids))).encode("utf-8")).hexdigest()


def _ts(x: Any) -> pd.Timestamp:
    t = pd.to_datetime(x, utc=True, errors="coerce")
    if pd.isna(t):
        raise ExportError(f"not a timestamp: {x!r}")
    return t


def _ts_col(s: pd.Series, name: str) -> pd.Series:
    t = pd.to_datetime(s, utc=True, errors="coerce")
    if t.isna().any():
        raise ExportError(f"{name} has missing or unreadable timestamps")
    return t


def _bool_col(s: pd.Series) -> pd.Series:
    return pd.Series([pa3._as_bool(x) for x in s], index=s.index, dtype=object)


def _blank(x: Any) -> bool:
    return x is None or (isinstance(x, float) and np.isnan(x)) or str(x).strip() == ""


def _check_manifest_hashes(manifest: Mapping[str, Any]) -> None:
    """A supplied digest must identify content, never stand in for missing provenance."""
    for key in (key for key in MANIFEST_KEYS_V4 if key.endswith("sha256")):
        value = manifest[key]
        if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
            raise ExportError(f"manifest {key} must be a 64-character lowercase SHA-256 digest")
    for entry in manifest["files"]:
        value = entry.get("sha256")
        if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
            raise ExportError("every manifest file sha256 must be a 64-character lowercase SHA-256 digest")


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

def load_bundle(manifest_path: str) -> Tuple[Dict[str, pd.DataFrame], Dict[str, Any]]:
    """Read the manifest and its three files; verify presence, SHA-256, row counts and the freeze hash."""
    mp = Path(manifest_path)
    manifest = json.loads(mp.read_text(encoding="utf-8"))
    missing = [k for k in MANIFEST_KEYS_V4 if k not in manifest]
    if missing:
        raise ExportError(f"manifest lacks required v4 keys: {missing}")
    _check_manifest_hashes(manifest)
    files = {f["role"]: f for f in manifest["files"]}
    if set(files) != FILE_ROLES or len(manifest["files"]) != len(FILE_ROLES):
        raise ExportError(f"manifest must list exactly one file for each role {sorted(FILE_ROLES)}")
    data: Dict[str, pd.DataFrame] = {}
    for role, f in files.items():
        p = mp.parent / f["name"]
        if Path(f["name"]).name != f["name"] or p.is_symlink():
            raise ExportError("bundle files must be local basenames, not paths or symlinks")
        if not p.exists():
            raise ExportError(f"{role} file {f['name']} is missing")
        got = pa3._sha256(p)
        if got != f["sha256"]:
            raise ExportError(f"SHA-256 mismatch for {f['name']}: manifest {f['sha256']}, file {got}")
        df = pd.read_csv(p, dtype=str, keep_default_na=False, na_values=[""])
        if int(f["rows"]) != len(df):
            raise ExportError(f"row count {len(df)} of {f['name']} differs from manifest {f['rows']}")
        data[role] = df
    if files["frozen_predictions"]["sha256"] != manifest["frozen_prediction_set_sha256"]:
        raise ExportError("frozen predictions differ from the prediction set hashed at the freeze "
                          "(a change to the ontology or mapping after the freeze cannot alter the predictions evaluated)")
    return data, manifest


# ---------------------------------------------------------------------------
# Validation and merge
# ---------------------------------------------------------------------------

def _check_manifest(manifest: Mapping[str, Any], allow_synthetic: bool) -> None:
    _check_manifest_hashes(manifest)
    if str(manifest["export_format_version"]) != EXPORT_FORMAT_VERSION_V4:
        raise ExportError(f"export_format_version {manifest['export_format_version']!r} is not {EXPORT_FORMAT_VERSION_V4}")
    if _blank(manifest["export_id"]):
        raise ExportError("manifest export_id must be nonblank")
    if manifest["mode"] != "FORMAL":
        raise ExportError("only FORMAL bundles are analysed; PILOT and CALIBRATION data never enter any statistic")
    if manifest["review_module"] != "ONTOLOGY_AREA":
        raise ExportError("this analysis reads Module A (ONTOLOGY_AREA) bundles only; Module B has its own analysis")
    if manifest["is_synthetic_fixture"] is not True:
        raise ExportError("SYNTHETIC ENGINEERING ONLY: real-data analysis is disabled; plan is not approved")
    if bool(manifest["is_synthetic_fixture"]) and not allow_synthetic:
        raise ExportError("manifest marks a synthetic fixture; pass allow_synthetic=True only in tests")
    if manifest["reference_locked"] is not True:
        raise ExportError("the blinded adjudicated reference is not locked; accuracy is not computed before the lock")
    if manifest["tier1_version_frozen"] not in TIER1_VERSIONS:
        raise ExportError(f"tier1_version_frozen must be one of {sorted(TIER1_VERSIONS)}")
    if manifest["adjudication_scope"] not in ADJUDICATION_SCOPES:
        raise ExportError(f"adjudication_scope must be one of {sorted(ADJUDICATION_SCOPES)}")


def _check_categories(nm: str, df: pd.DataFrame, allowed: set, ext_ok: bool, allow_synthetic: bool) -> None:
    cats = set(df.record_category.astype(str))
    bad = cats & NEVER_ANALYSED
    if bad:
        raise ExportError(f"{nm} contains {sorted(bad)} records; development, pilot, calibration and unadopted "
                          "reserve records never enter the held-out performance dataset")
    if "HELDOUT_EXTENSION_APPROVED" in cats and not ext_ok:
        raise ExportError(f"{nm} contains extension records but no protocol amendment approved the extension before the freeze")
    unknown = cats - allowed
    if unknown:
        raise ExportError(f"{nm} has record categories outside {sorted(allowed)}: {sorted(unknown)}")
    ids = df.case_id.astype(str)
    for pre in NEVER_HELDOUT_PREFIXES:
        if ids.str.startswith(pre).any():
            raise ExportError(f"{nm}: case IDs with prefix {pre} are never held-out cases")
    for cat, pre in RECORD_PREFIX.items():
        m = df.record_category == cat
        if m.any() and not ids[m].str.startswith(pre).all():
            raise ExportError(f"{nm}: a {cat} record does not carry the {pre} prefix")
    held = df.record_category == "HELDOUT_FORMAL"
    if ids[held].str.startswith("HO4R-").any():
        raise ExportError(f"{nm}: an HO4R- (extension) case is labelled HELDOUT_FORMAL")
    if not ids.str.fullmatch(r"HO4R?-TESTFX-[0-9]+").all():
        raise ExportError("SYNTHETIC ENGINEERING ONLY: expected fictional TESTFX case identifiers")
    if ids.str.contains(SYNTHETIC_CASE_MARK).any() and not allow_synthetic:
        raise ExportError(f"{nm}: synthetic fixture case IDs found; not study data")


def _check_case_metadata(J: pd.DataFrame, A: pd.DataFrame, P: pd.DataFrame) -> None:
    """Validate source metadata before joining; optional SQL NULLs compare as absent."""
    shared = ("record_category", "unit_type", "unit_id", "nct_id", "descriptor_ui", "area")
    # case_version is provided only by the judgment export in format 4.0. It can
    # be checked for agreement and preserved, but cannot be compared to a frozen
    # version that the prediction/reference files do not contain.
    version_text = J.case_version.astype(str)
    if not version_text.str.fullmatch(r"[0-9]+").all():
        raise ExportError("case_version must be a nonmissing positive integer in every judgment")
    versions = version_text.map(int)
    if (versions < 1).any():
        raise ExportError("case_version must be a nonmissing positive integer in every judgment")
    if (versions.groupby(J.case_id).nunique() != 1).any():
        raise ExportError("case_version must agree across all reviewers and levels of each case")
    J["case_version"] = versions
    normalized = {}
    for name, frame, columns in (("independent_judgments", J, shared + ("descriptor_name",)),
                                 ("adjudicated_reference", A, ("record_category",)),
                                 ("frozen_predictions", P, shared)):
        values = frame[list(columns)].map(lambda value: None if _blank(value) else value)
        values["case_id"] = frame.case_id
        for column in columns:
            if (values.groupby("case_id")[column].nunique(dropna=False) != 1).any():
                raise ExportError(f"{name}: {column} must stay consistent across each case's rows")
        if "unit_type" in columns:
            if not frame.unit_type.isin(("DESCRIPTOR_AREA", "TRIAL_AREA")).all():
                raise ExportError(f"{name}: unit_type must identify a descriptor-area or trial-area case")
            if frame.unit_id.map(_blank).any():
                raise ExportError(f"{name}: unit_id must be nonblank")
        normalized[name] = values.drop_duplicates("case_id").set_index("case_id")
    predictions = normalized["frozen_predictions"]
    for name, columns in (("independent_judgments", shared), ("adjudicated_reference", ("record_category",))):
        values = normalized[name].reindex(predictions.index)
        for column in columns:
            left, right = values[column], predictions[column]
            if not (left.eq(right) | (left.isna() & right.isna())).all():
                raise ExportError(f"{name}: {column} differs from frozen prediction case metadata")


def _check_case_sampling(P: pd.DataFrame) -> None:
    """Both trial determinations inherit one case design and one case record."""
    # These are the numeric case_design_v3 columns exported by
    # v_frozen_predictions_v4. Decimal equality preserves database numeric values
    # without rejecting equivalent encodings or rounding a real mismatch away.
    for column in ("selection_probability", "sampling_weight", "variance_stratum_size"):
        try:
            values = P[column].map(lambda value: Decimal(str(value)))
        except InvalidOperation as exc:
            raise ExportError(f"{column} must contain finite numeric design values") from exc
        if not values.map(lambda value: value.is_finite()).all():
            raise ExportError(f"{column} must contain finite numeric design values")
        if (values.groupby(P.case_id).nunique() != 1).any():
            raise ExportError(f"{column} must stay consistent across each case's determination levels")
    # The first three fields also come from case_design_v3; the remaining fields
    # are case_records_v4 attributes, not level-specific prediction outputs.
    for column in ("selection_stratum", "variance_stratum", "comparison_cell", "impact_tier",
                   "provenance_audit_result", "policy_governed_neoplasm_GEN06"):
        values = (_bool_col(P[column]) if column == "policy_governed_neoplasm_GEN06" else
                  P[column].map(lambda value: None if _blank(value) else value))
        if (values.groupby(P.case_id).nunique(dropna=False) != 1).any():
            raise ExportError(f"{column} must stay consistent across each case's determination levels")


def validate_bundle(data: Mapping[str, pd.DataFrame], manifest: Mapping[str, Any], allow_synthetic: bool = False,
                    allow_exposed_reference: bool = False) -> Tuple[pd.DataFrame, List[str]]:
    """Apply every v4 rule. Raises ExportError on any breach.

    Returns (M, passed): M has one row per case x determination level in the column layout that
    performance_analysis_v3 reads ('original_binary' holds Tier 0, 'curated_v11_binary' holds the
    frozen Tier 1 version); passed lists the checks that passed, in order.
    """
    passed: List[str] = []
    _check_manifest(manifest, allow_synthetic)
    passed.append("manifest: format 4.0, FORMAL, ONTOLOGY_AREA, reference locked, frozen Tier 1 version named")

    J = data["independent_judgments"].copy()
    A = data["adjudicated_reference"].copy()
    P = data["frozen_predictions"].copy()
    for nm, df, cols in (("independent_judgments", J, JUDGMENT_COLUMNS), ("adjudicated_reference", A, ADJUDICATION_COLUMNS),
                         ("frozen_predictions", P, PREDICTION_COLUMNS)):
        miss = [c for c in cols if c not in df.columns]
        if miss:
            raise ExportError(f"{nm} lacks required columns: {miss}")
        bad = set(df.determination_level) - LEVELS_V4
        if bad:
            raise ExportError(f"{nm} has unknown determination levels: {sorted(bad)}")
    for nm, df in (("independent_judgments", J), ("adjudicated_reference", A)):
        if not df.export_id.eq(manifest["export_id"]).fillna(False).all():
            raise ExportError(f"{nm}: every export_id must match the manifest export_id")
    if not J.review_module.eq(manifest["review_module"]).fillna(False).all():
        raise ExportError("independent_judgments: every review_module must match the manifest review_module")
    passed.append("columns: every required v4 column present; determination levels known; export IDs and review module match manifest")

    # ---- record categories and identifier prefixes --------------------------
    ext_ok = manifest["extension_approved_by_amendment"] is True and not _blank(manifest.get("amendment_id"))
    allowed = {"HELDOUT_FORMAL"} | ({"HELDOUT_EXTENSION_APPROVED"} if ext_ok else set())
    for nm, df in (("independent_judgments", J), ("adjudicated_reference", A), ("frozen_predictions", P)):
        _check_categories(nm, df, allowed, ext_ok, allow_synthetic)
    passed.append("record categories: only held-out formal records (plus an amendment-approved extension, if any); prefixes match")

    # ---- case lists ----------------------------------------------------------
    cj, ca, cp = set(J.case_id), set(A.case_id), set(P.case_id)
    if not (cj == ca == cp):
        raise ExportError(f"case lists differ across files (judgments {len(cj)}, adjudications {len(ca)}, predictions {len(cp)})")
    if case_list_sha256(cp) != manifest["frozen_sample_case_list_sha256"]:
        raise ExportError("case list does not match the frozen sample case list (a case was added, dropped or renamed after the freeze)")
    kp = set(zip(P.case_id, P.determination_level))
    if set(zip(A.case_id, A.determination_level)) != kp or set(zip(J.case_id, J.determination_level)) != kp:
        raise ExportError("case x determination level pairs differ across the three files (every case level is adjudicated)")
    passed.append("case list: identical in the three files, equal to the frozen sample case list; every case level adjudicated")

    # ---- frozen predictions --------------------------------------------------
    if P.duplicated(["case_id", "determination_level"]).any():
        raise ExportError("duplicate case x determination level rows in the frozen predictions")
    _check_case_metadata(J, A, P)
    if P.frame_unit_id.map(_blank).any():
        raise ExportError("frame_unit_id must be nonblank for every frozen prediction")
    if (P.groupby("case_id").frame_unit_id.nunique() != 1).any():
        raise ExportError("frame_unit_id must stay consistent across each case's determination levels")
    if (P.groupby("frame_unit_id").case_id.nunique() != 1).any():
        raise ExportError("frame_unit_id must identify only one case")
    if P.prediction_set_id.map(_blank).any() or P.prediction_set_id.nunique() != 1:
        raise ExportError("frozen predictions must carry one nonblank prediction_set_id")
    if set(P.tier1_version) != {manifest["tier1_version_frozen"]}:
        raise ExportError(f"predictions carry Tier 1 versions {sorted(set(P.tier1_version))}; "
                          f"the frozen version is {manifest['tier1_version_frozen']}")
    frozen_at = _ts(manifest["frozen_at"])
    if (_ts_col(P.prediction_frozen_at, "prediction_frozen_at") > frozen_at).any():
        raise ExportError("a prediction was recorded after the freeze; frozen predictions cannot change once validation starts")
    for col in ("tier0_binary", "tier1_binary"):
        vals = set(P[col].astype(str)) - {POS, NEG}
        if vals:
            raise ExportError(f"{col} must be INCLUDE or EXCLUDE; found {sorted(vals)}")
    vals = set(P.tier1_status_raw.astype(str)) - pa3.CURATED_STATUSES
    if vals:
        raise ExportError(f"tier1_status_raw has unknown statuses: {sorted(vals)}")
    dl = P[P.determination_level != "TRIAL_LEVEL"]
    exp = np.array([pa3.expected_curated_binary(o, s, lvl) for o, s, lvl in
                    zip(dl.tier0_binary, dl.tier1_status_raw, dl.determination_level)], dtype=object)
    mism = dl.loc[exp != dl.tier1_binary.to_numpy(dtype=object), "case_id"].tolist()
    if mism:
        raise ExportError(f"tier1_binary disagrees with the deterministic mapping policy for cases: {mism[:10]}")
    stage_c = P.stage_c_trial_status.map(lambda value: None if _blank(value) else value)
    if (~(stage_c.isna() | stage_c.isin(("INCLUDE", "EXCLUDE", "UNRESOLVED")))).any():
        raise ExportError("stage_c_trial_status must be blank, INCLUDE, EXCLUDE or UNRESOLVED")
    tl = P[P.determination_level == "TRIAL_LEVEL"]
    exp_t = np.array([pa3.expected_curated_binary(o, "CONTEXT_DEPENDENT", "TRIAL_LEVEL", None if _blank(sc) else sc)
                      for o, sc in zip(tl.tier0_binary, tl.stage_c_trial_status)], dtype=object)
    mism_t = tl.loc[exp_t != tl.tier1_binary.to_numpy(dtype=object), "case_id"].tolist()
    if mism_t:
        raise ExportError(f"trial-level tier1_binary disagrees with the Stage C or retained-membership rule for cases: {mism_t[:10]}")
    if (P.provenance_audit_result != "NO_DEVELOPMENT_FLAG").any():
        raise ExportError("a predicted case lacks provenance result NO_DEVELOPMENT_FLAG: a development unit cannot be held out")
    w = pd.to_numeric(P.sampling_weight, errors="coerce")
    p = pd.to_numeric(P.selection_probability, errors="coerce")
    if w.isna().any() or (w <= 0).any() or (p > 1).any() or not np.allclose(w * p, 1.0, rtol=1e-6):
        raise ExportError("sampling_weight must equal 1 / selection_probability (probability in (0, 1]) for every row")
    sizes = pd.to_numeric(P.variance_stratum_size, errors="coerce")
    if not np.isfinite(sizes).all() or (sizes < 1).any() or (sizes % 1 != 0).any() or P.variance_stratum.isna().any():
        raise ExportError("variance stratum sizes must be finite positive integers with named strata")
    _check_case_sampling(P)
    design = P.assign(_size=sizes)
    for _, group in design.groupby(["determination_level", "variance_stratum"]):
        if group._size.nunique() != 1 or group._size.iloc[0] < len(group):
            raise ExportError("variance stratum sizes must be consistent and at least the sample count")
    passed.append("predictions: matching case metadata, one case per frame unit, frozen hash and Tier 1 version, "
                  "recorded before the freeze, consistent with the mapping "
                  "policy, provenance NO_DEVELOPMENT_FLAG, weight = 1 / probability")

    # ---- independent judgments ----------------------------------------------
    for c in ("decision_initial", "decision_effective_preclose"):
        if J[c].isna().any():
            raise ExportError(f"{c} is blank in a judgment row (rows exist only for submitted judgments)")
        bad = set(J[c].astype(str)) - set(L1_CODES)
        if bad:
            raise ExportError(f"{c} has codes outside the layer-1 scale: {sorted(bad)}")
    if not set(J.reviewer_slot.astype(str)) <= {"1", "2"}:
        raise ExportError("reviewer_slot must be 1 or 2")
    if J.duplicated(["case_id", "determination_level", "reviewer_slot"]).any():
        raise ExportError("duplicate judgment rows for a case x level x reviewer slot")
    g = J.groupby(["case_id", "determination_level"])
    if (g.reviewer_pseudo_id.nunique() != g.reviewer_slot.nunique()).any():
        raise ExportError("the two judgments of a case level must come from two different reviewers")
    nrev = pd.to_numeric(J.n_revisions_preclose, errors="coerce")
    if nrev.isna().any() or (nrev < 0).any() or (nrev % 1 != 0).any():
        raise ExportError("n_revisions_preclose must be a non-negative integer")
    J["n_revisions_preclose"] = nrev.astype(int)
    J["uncertain"] = _bool_col(J.uncertain)
    if J.uncertain.isna().any():
        raise ExportError("uncertain must be an explicit boolean for every submitted judgment")
    if ((J.decision_initial != J.decision_effective_preclose) & (nrev == 0)).any():
        raise ExportError("a judgment changed between the initial and effective answer but records no revision")
    opened_at, closed_at = _ts(manifest["formal_phase_opened_at"]), _ts(manifest["formal_phase_closed_at"])
    if opened_at < frozen_at:
        raise ExportError("the formal phase opened before the freeze")
    jf = _ts_col(J.first_submitted_at, "first_submitted_at")
    jl = _ts_col(J.last_submitted_at, "last_submitted_at")
    if (jf < opened_at).any() or (jl > closed_at).any() or (jl < jf).any():
        raise ExportError("an independent judgment falls outside the formal phase (before the opening or after the close)")
    passed.append("independent judgments: layer-1 codes, two different reviewers per case level, revisions recorded, "
                  "submitted inside the formal phase")

    # ---- adjudicated reference ----------------------------------------------
    for c in ("adjudication_blinded", "adjudicator_exposed_to_index_labels", "post_unblinding_revision_exists"):
        A[c] = _bool_col(A[c])
        if A[c].isna().any():
            raise ExportError(f"{c} must be an explicit boolean for every adjudication")
    if A.duplicated(["case_id", "determination_level"]).any():
        raise ExportError("more than one primary adjudication per case level (the primary reference is the last blinded adjudication)")
    bad = set(A.adjudicated_decision.dropna().astype(str)) - set(L1_CODES)
    if bad:
        raise ExportError(f"adjudicated_decision has codes outside the layer-1 scale: {sorted(bad)}")
    bad = set(A.adjudication_status.astype(str)) - set(ADJUDICATION_STATUSES_V4)
    if bad:
        raise ExportError(f"unknown adjudication_status values: {sorted(bad)}")
    bad = set(A.adjudication_basis.astype(str)) - set(rc.ADJUDICATION_BASES)
    if bad:
        raise ExportError(f"unknown adjudication_basis values: {sorted(bad)}")
    unres = A.adjudication_status == "UNRESOLVED_ESCALATED"
    if (A.adjudicated_decision[unres].notna()).any() or (A.adjudicated_decision[~unres].isna()).any():
        raise ExportError("adjudicated_decision must be blank exactly when adjudication_status is UNRESOLVED_ESCALATED")
    if ((A.adjudication_basis == "NONE") != unres).any():
        raise ExportError("adjudication_basis must be NONE exactly when adjudication_status is UNRESOLVED_ESCALATED")
    if A.adjudicator_pseudo_id.map(_blank).any():
        raise ExportError("adjudicator_pseudo_id must be nonblank for every reference record")
    rule = A.adjudication_status == "CONCORDANT_ADOPTED_BY_RULE"
    if ((A.adjudicator_pseudo_id[rule] != RULE_ADJUDICATOR) | (A.adjudicator_role[rule] != "CONCORDANCE_RULE")).any() or \
            (A.adjudicator_pseudo_id[~rule] == RULE_ADJUDICATOR).any():
        raise ExportError("CONCORDANT_ADOPTED_BY_RULE rows, and only they, carry adjudicator RULE with role CONCORDANCE_RULE")
    if not A.loc[~rule, "adjudicator_role"].isin(("ADJUDICATOR", "INVESTIGATOR")).all():
        raise ExportError("non-rule adjudicator_role must be ADJUDICATOR or an explicitly exposed INVESTIGATOR")
    investigator = A.adjudicator_role == "INVESTIGATOR"
    if (investigator & ((A.adjudicator_exposed_to_index_labels != True) |  # noqa: E712
                       (A.adjudication_blinded != False))).any():  # noqa: E712
        raise ExportError("INVESTIGATOR adjudication must explicitly record exposure and cannot be blinded")
    if manifest["adjudication_scope"] == "ALL_CASE_LEVELS" and rule.any():
        raise ExportError("adjudication_scope ALL_CASE_LEVELS: every case level needs an adjudicator decision, none by rule")
    if set(A.adjudicator_pseudo_id.dropna()) & set(J.reviewer_pseudo_id.dropna()):
        raise ExportError("an adjudicator also reviewed cases; the adjudicator must be a separate person")
    exposed = (np.array([x is True for x in A.adjudicator_exposed_to_index_labels])
               | ~np.array([x is True for x in A.adjudication_blinded]))
    if exposed.any() and not allow_exposed_reference:
        raise ExportError("the primary reference includes adjudications exposed to classifier outputs; "
                          "pass allow_exposed_reference=True only for a labelled secondary analysis")
    at = _ts_col(A.adjudicated_at, "adjudicated_at")
    lock_at = _ts(manifest["reference_locked_at"])
    if (at < closed_at).any() or (at > lock_at).any():
        raise ExportError("a primary adjudication falls outside the window between the close and the reference lock")
    if set(A.reference_lock_id.astype(str)) != {str(manifest["reference_lock_id"])}:
        raise ExportError("adjudications do not all belong to the manifest's reference lock")
    passed.append("adjudications: one primary per case level, statuses valid, adjudicator distinct from reviewers, "
                  "blinded, between the close and the lock")

    # ---- merge into the v3 analysis layout ----------------------------------
    jrec = {(r.case_id, r.determination_level, str(r.reviewer_slot)): r for r in J.itertuples(index=False)}
    arec = {(r.case_id, r.determination_level): r for r in A.itertuples(index=False)}
    case_versions = J.groupby("case_id").case_version.first().to_dict()
    rows = []
    for r in P.itertuples(index=False):
        key = (r.case_id, r.determination_level)
        out: Dict[str, Any] = {
            "export_id": manifest["export_id"], "mode": "FORMAL", "is_pilot": False, "case_id": r.case_id,
            "case_version": case_versions[r.case_id],
            "review_module": "ONTOLOGY_AREA", "unit_type": r.unit_type, "unit_id": r.unit_id, "nct_id": r.nct_id,
            "descriptor_ui": r.descriptor_ui, "area": r.area, "determination_level": r.determination_level,
            "layer": "clinical_classification", "analysis_set": "VALIDATION_HELDOUT", "record_category": r.record_category,
            "selection_stratum": r.selection_stratum, "variance_stratum": r.variance_stratum,
            "selection_probability": float(r.selection_probability), "sampling_weight": float(r.sampling_weight),
            "variance_stratum_size": float(r.variance_stratum_size), "comparison_cell_v11": r.comparison_cell,
            "impact_tier": r.impact_tier, "policy_governed_neoplasm_GEN06": pa3._as_bool(r.policy_governed_neoplasm_GEN06),
            "original_binary": r.tier0_binary, "curated_v11_status_raw": r.tier1_status_raw,
            "curated_v11_binary": r.tier1_binary, "tier1_version": r.tier1_version}
        eff = []
        for slot in ("1", "2"):
            j = jrec.get(key + (slot,))
            out[f"reviewer_{slot}_pseudo_id"] = None if j is None else j.reviewer_pseudo_id
            out[f"reviewer_{slot}_decision"] = None if j is None else j.decision_effective_preclose
            out[f"reviewer_{slot}_decision_initial"] = None if j is None else j.decision_initial
            out[f"reviewer_{slot}_uncertain"] = None if j is None else j.uncertain
            out[f"reviewer_{slot}_n_revisions_preclose"] = None if j is None else j.n_revisions_preclose
            if j is not None:
                eff.append(j.decision_effective_preclose)
        out["double_reviewed"] = len(eff) == 2
        out["reviewers_agree"] = (eff[0] == eff[1]) if len(eff) == 2 else None
        a = arec[key]
        for c in ("adjudication_id", "adjudicated_decision", "adjudication_status", "adjudication_basis",
                  "disagreement_reason_code", "adjudicator_role", "adjudication_blinded",
                  "adjudicator_exposed_to_index_labels", "post_unblinding_revision_exists"):
            v = getattr(a, c)
            out[c] = None if (not isinstance(v, bool) and _blank(v)) else v
        rows.append(out)
    M = pd.DataFrame(rows)
    disc = M.double_reviewed & (M.reviewers_agree == False)  # noqa: E712
    codes = M.loc[disc, "disagreement_reason_code"]
    if codes.isna().any():
        raise ExportError("a discordant case level has no disagreement reason code")
    bad = set(codes.astype(str)) - set(pa3.DISAGREEMENT_REASONS)
    if bad:
        raise ExportError(f"unknown disagreement reason codes: {sorted(bad)}")
    st = M.adjudication_status.astype(str)
    agree = M.double_reviewed & (M.reviewers_agree == True)  # noqa: E712
    single = ~M.double_reviewed
    if (st.str.startswith("CONCORDANT") & ~agree).any():
        raise ExportError("a CONCORDANT adjudication status is recorded where the reviewers did not agree")
    if ((st == "SINGLE_REVIEW_ADJUDICATED") != (single & (st != "UNRESOLVED_ESCALATED"))).any():
        raise ExportError("a single-reviewed case level must be SINGLE_REVIEW_ADJUDICATED or UNRESOLVED_ESCALATED, and only it")
    if ((st == "DISCORDANT_RESOLVED") & ~disc).any():
        raise ExportError("DISCORDANT_RESOLVED is recorded where the reviewers did not disagree")
    by_rule = st == "CONCORDANT_ADOPTED_BY_RULE"
    if (M.loc[by_rule, "adjudicated_decision"] != M.loc[by_rule, "reviewer_1_decision"]).any():
        raise ExportError("a CONCORDANT_ADOPTED_BY_RULE reference differs from the reviewers' shared answer")
    same_reference = M.adjudicated_decision == M.reviewer_1_decision
    if ((st == "CONCORDANT_CONFIRMED") & ~same_reference).any():
        raise ExportError("a CONCORDANT_CONFIRMED reference must equal the reviewers' shared answer")
    if ((st == "CONCORDANT_REVISED") & same_reference).any():
        raise ExportError("a CONCORDANT_REVISED reference must differ from the reviewers' shared answer")
    for slot in ("1", "2"):
        adopted = M.adjudication_basis == f"REVIEWER_{slot}"
        decision = M[f"reviewer_{slot}_decision"]
        if (adopted & (decision.isna() | (M.adjudicated_decision != decision))).any():
            raise ExportError(f"adjudication_basis REVIEWER_{slot} must adopt that reviewer's submitted decision")
    both = M.adjudication_basis == "BOTH_REVIEWERS"
    if (both & (~agree | ~same_reference)).any():
        raise ExportError("adjudication_basis BOTH_REVIEWERS must adopt both reviewers' shared decision")
    neither = M.adjudication_basis == "NEITHER"
    if (neither & ((M.adjudicated_decision == M.reviewer_1_decision) |
                   (M.adjudicated_decision == M.reviewer_2_decision))).any():
        raise ExportError("adjudication_basis NEITHER must differ from every submitted reviewer decision")
    if manifest["adjudication_scope"] == "DISAGREEMENTS_ONLY" and (agree & ~by_rule).any():
        raise ExportError("adjudication_scope DISAGREEMENTS_ONLY: concordant case levels enter the reference by rule only")
    passed.append("merge: judgments, adjudications and predictions joined one to one per case level; reason codes valid; "
                  "adjudication status and basis consistent with reviewer decisions and the adjudication scope")
    return M, passed


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------

def initial_submission_agreement(M: pd.DataFrame) -> Dict[str, Any]:
    """Reviewer agreement on the INITIAL answers (kept before any revision), by determination level."""
    out: Dict[str, Any] = {}
    for level, g in M.groupby("determination_level"):
        r1i, r2i = g.reviewer_1_decision_initial.fillna(""), g.reviewer_2_decision_initial.fillna("")
        revised = ((g.reviewer_1_n_revisions_preclose.fillna(0) > 0) |
                   (g.reviewer_2_n_revisions_preclose.fillna(0) > 0))
        dr = g[(r1i != "") & (r2i != "")]
        entry: Dict[str, Any] = {"n_double_reviewed": int(len(dr)),
                                 "n_case_levels_with_any_revision": int(revised.sum())}
        if len(dr):
            entry["initial_submissions"] = am.agreement_summary(dr.reviewer_1_decision_initial, dr.reviewer_2_decision_initial, L1_CODES)
        out[level] = entry
    return out


def build_results(M: pd.DataFrame, manifest: Mapping[str, Any], passed: List[str]) -> Dict[str, Any]:
    if manifest.get("is_synthetic_fixture") is not True or not M.case_id.astype(str).str.fullmatch(r"HO4R?-TESTFX-[0-9]+").all():
        raise ExportError("SYNTHETIC ENGINEERING ONLY: real-data and pilot analysis disabled")
    tier1 = manifest["tier1_version_frozen"]
    cases = M.drop_duplicates("case_id")
    res: Dict[str, Any] = {
        "notice": "SYNTHETIC ENGINEERING ONLY — analysis plan is not approved; no clinical results",
        "module_version": __version__, "performance_analysis_v3_version": pa3.__version__,
        "agreement_metrics_version": am.__version__, "export_format_version": EXPORT_FORMAT_VERSION_V4,
        "numpy_version": np.__version__, "pandas_version": pd.__version__,
        "export_id": manifest["export_id"], "freeze_manifest_id": manifest["freeze_manifest_id"],
        "freeze_manifest_sha256": manifest["freeze_manifest_sha256"],
        "frozen_prediction_set_sha256": manifest["frozen_prediction_set_sha256"],
        "frozen_sample_case_list_sha256": manifest["frozen_sample_case_list_sha256"],
        "reference_lock_id": manifest["reference_lock_id"], "adjudication_scope": manifest["adjudication_scope"],
        "adjudication_status_counts": M.adjudication_status.fillna("MISSING").value_counts().to_dict(),
        "tier0_label": "Tier 0: deterministic MeSH subtree mapping (frozen)",
        "tier1_label": f"Tier 1: AI-curated classification {tier1} (frozen; PROVISIONAL until clinically validated)",
        "tier1_version_evaluated": tier1, "is_synthetic_fixture": bool(manifest["is_synthetic_fixture"]),
        "integrity_checks_passed": passed,
        "counts": {"cases": int(len(cases)),
                   "cases_by_unit_type": cases.unit_type.value_counts().to_dict(),
                   "rows_by_level": M.determination_level.value_counts().to_dict(),
                   "record_categories": cases.record_category.value_counts().to_dict(),
                   "double_reviewed_case_levels": int(M.double_reviewed.sum()),
                   "independent_judgments": int(M.reviewer_1_decision.notna().sum() + M.reviewer_2_decision.notna().sum())},
        "reviewer_agreement": pa3.reviewer_agreement(M),
        "reviewer_agreement_initial_submissions": initial_submission_agreement(M),
        "accuracy": {}, "paired_comparison": {}, "per_area": {},
        "disagreements": pa3.disagreement_summary(M), "trial_two_step": pa3.trial_two_step_summary(M),
        "uncertainty": pa3.uncertainty_summary(M), "blinding": pa3.blinding_summary(M),
        "denominator_rules": pa3.DENOMINATOR_RULES,
        "labels": {
            "index_naming": "In every accuracy block 'original_technical' is Tier 0 and 'curated_v11' is Tier 1 "
                            f"(the frozen version, here {tier1}); the key names are kept from export format 3.0.",
            "unweighted": "sample-restricted: describes the enriched held-out sample, not the inference population",
            "design_weighted": "design-weighted to the held-out inference population (Hajek ratio, stratified "
                               "linearization, Wilson interval at the effective size capped at the domain count; "
                               "the uncapped interval is also reported)",
            "agreement": "reviewer-reviewer agreement is consistency between two clinicians, not accuracy",
        },
        "not_estimable_by_design": [
            "accuracy of Tier 1 additions: requires an adequate identifiable denominator in an approved design",
            "sensitivity, specificity, PPV and NPV within a therapeutic area unless the denominator reaches the prespecified threshold",
            "trial-level accuracy beyond a description of the sampled context-dependent trial cases",
            "performance on development, calibration or pilot cases (never computed from formal data)",
            "PPR condition-row eligibility and benchmark compatibility (Module B, separate analysis)",
            "far out-of-frame pairs (outside the inference population; negative for both tiers by construction)",
        ],
    }
    for level in ("DESCRIPTOR_LEVEL", "TRIAL_LEVEL"):
        res["accuracy"][level] = {rule: pa3.classifier_vs_reference(M, level, "VALIDATION_HELDOUT", rule)
                                  for rule in pa3.DENOMINATOR_RULES}
        res["paired_comparison"][level] = pa3.paired_comparison(M, level, "VALIDATION_HELDOUT", "R0_primary")
        res["per_area"][level] = pa3.per_area(M, level, "VALIDATION_HELDOUT")
    return res


# ---------------------------------------------------------------------------
# Manuscript block: fills {{SLOT}} markers from computed values only
# ---------------------------------------------------------------------------
DESC = "accuracy.DESCRIPTOR_LEVEL.R0_primary"
PAIR = "paired_comparison.DESCRIPTOR_LEVEL"
RA = "reviewer_agreement.ONTOLOGY_AREA|DESCRIPTOR_LEVEL"
SLOT_MAP_V4: Dict[str, Tuple[str, str]] = {
    "N_HELDOUT_CASES": ("counts.cases", "int"),
    "N_INDEPENDENT_JUDGMENTS": ("counts.independent_judgments", "int"),
    "N_DOUBLE_REVIEWED_DESCRIPTOR": (f"{RA}.n_double_reviewed", "int"),
    "RAW_AGREEMENT_DESCRIPTOR": (f"{RA}.all_sets.raw_agreement.estimate", "pct"),
    "RAW_AGREEMENT_DESCRIPTOR_CI": (f"{RA}.all_sets.raw_agreement", "ci_pct"),
    "KAPPA_DESCRIPTOR": (f"{RA}.all_sets.kappa.kappa", "num2"),
    "KAPPA_DESCRIPTOR_CI": (f"{RA}.all_sets.kappa", "ci_num"),
    "N_HELDOUT_DESCRIPTOR": (f"{DESC}.n_cases", "int"),
    "N_HELDOUT_BINARY": (f"{DESC}.curated_v11.n_binary_pairs", "int"),
    "N_REFERENCE_NONDIRECTIONAL": (f"{DESC}.reference_counts", "nondir"),
    "SENS_TIER0_W": (f"{DESC}.original_technical.design_weighted.sensitivity", "est_ci_pct"),
    "SENS_TIER1_W": (f"{DESC}.curated_v11.design_weighted.sensitivity", "est_ci_pct"),
    "SPEC_TIER0_W": (f"{DESC}.original_technical.design_weighted.specificity", "est_ci_pct"),
    "SPEC_TIER1_W": (f"{DESC}.curated_v11.design_weighted.specificity", "est_ci_pct"),
    "N_DISCORDANT": (f"{PAIR}.discordant_units", "int"),
    "N_DISCORDANT_TIER1_CORRECT": (f"{PAIR}.discordant_curated_correct", "int"),
    "N_DISCORDANT_TIER0_CORRECT": (f"{PAIR}.discordant_original_correct", "int"),
    "TIER1_VERSION": ("tier1_version_evaluated", "text"),
}


def render_manuscript_block(results: Mapping[str, Any], template: str, allow_synthetic: bool = False) -> Tuple[str, pd.DataFrame]:
    """Fill {{SLOT}} markers from computed results only. Raises MissingResultError on any slot without a finite value."""
    if results.get("is_synthetic_fixture") is not True:
        raise ExportError("SYNTHETIC ENGINEERING ONLY: clinical result rendering disabled")
    if results.get("is_synthetic_fixture") and not allow_synthetic:
        raise ExportError("results come from a synthetic fixture; refusing to render a manuscript block")
    slots = sorted(set(re.findall(r"\{\{([A-Z0-9_]+)\}\}", template)))
    trace, filled = [], template
    for slot in slots:
        if slot not in SLOT_MAP_V4:
            raise pa3.MissingResultError(f"template slot {slot} is not defined in SLOT_MAP_V4")
        path, kind = SLOT_MAP_V4[slot]
        value = pa3._get(results, path)
        text = str(value) if kind == "text" else pa3._format(kind, value)
        trace.append({"slot": slot, "results_path": path, "rendered": text})
        filled = filled.replace("{{" + slot + "}}", text)
    if re.search(r"\{\{[A-Z0-9_]+\}\}", filled):
        raise pa3.MissingResultError("unfilled slots remain")
    if results.get("is_synthetic_fixture"):
        filled = "SYNTHETIC TEST OUTPUT. NOT STUDY RESULTS.\n\n" + filled
    return filled, pd.DataFrame(trace)


def run(manifest_path: str, allow_synthetic: bool = False, allow_exposed_reference: bool = False) -> Dict[str, Any]:
    data, manifest = load_bundle(manifest_path)
    M, passed = validate_bundle(data, manifest, allow_synthetic, allow_exposed_reference)
    return build_results(M, manifest, passed)


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--template")
    ap.add_argument("--allow-synthetic", action="store_true")
    a = ap.parse_args(argv)
    res = run(a.manifest, a.allow_synthetic)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "performance_results_v4.json").write_text(json.dumps(pa3._jsonable(res), indent=2, sort_keys=True), encoding="utf-8")
    if a.template:
        block, trace = render_manuscript_block(res, Path(a.template).read_text(encoding="utf-8"), a.allow_synthetic)
        (out / "clinical_review_results_block_v4.md").write_text(block, encoding="utf-8")
        trace.to_csv(out / "clinical_review_results_block_v4_trace.csv", index=False)
    print("SYNTHETIC ENGINEERING ONLY — analysis plan not approved; no clinical results")
    print(f"wrote {out / 'performance_results_v4.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
