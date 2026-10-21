"""SYNTHETIC ENGINEERING ONLY. Proposed analysis; no clinical study results."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

try:  # package import (repository root on sys.path)
    from analysis import agreement_metrics as am
    from analysis import review_codes as rc
except ImportError:  # run from inside analysis/
    import agreement_metrics as am  # type: ignore
    import review_codes as rc  # type: ignore

__version__ = "3.0.1"
EXPORT_FORMAT_VERSION_V3 = "3.0"

POS, NEG = "INCLUDE", "EXCLUDE"
L1_CODES = ["INCLUDE", "EXCLUDE", "CONTEXT_DEPENDENT", "INSUFFICIENT_INFORMATION"]
NONDIRECTIONAL = {"CONTEXT_DEPENDENT", "INSUFFICIENT_INFORMATION"}
CURATED_STATUSES = {"INCLUDE", "EXCLUDE", "CONTEXT_DEPENDENT", "INSUFFICIENT_EVIDENCE", "NOT_IN_DECISION_FILE"}
ANALYSIS_SETS = {"VALIDATION_HELDOUT", "DEVELOPMENT_KNOWN_ISSUE"}
DETERMINATION_LEVELS = {"DESCRIPTOR_LEVEL", "TRIAL_LEVEL", "DESCRIPTOR_LEVEL_IN_TRIAL_CASE"}
REVIEW_MODULES = {"ONTOLOGY_AREA", "BENCHMARK_COMPATIBILITY"}
DISAGREEMENT_REASONS = ["CONSTRUCT_BOUNDARY", "POLICY_RULE_INTERPRETATION", "MESH_PLACEMENT_MISLEADING",
                        "TRIAL_CONTEXT", "PACKET_INSUFFICIENT", "MULTILABEL_OR_CROSS_AREA", "OTHER"]
DENOMINATOR_RULES = {
    "R0_primary": "reference CONTEXT_DEPENDENT, INSUFFICIENT_INFORMATION or unresolved: excluded from binary metrics and counted by reason",
    "R1_bound_nondirectional_as_include": "reference CONTEXT_DEPENDENT or INSUFFICIENT_INFORMATION treated as INCLUDE (unresolved still excluded)",
    "R2_bound_nondirectional_as_exclude": "reference CONTEXT_DEPENDENT or INSUFFICIENT_INFORMATION treated as EXCLUDE (unresolved still excluded)",
}
MIN_AREA_DENOMINATOR = 10          # prespecified per-area reporting threshold (reference positives / negatives / index positives)
MIN_UNITS_FOR_WEIGHTED = 10        # below this many binary units a weighted estimate is reported as not estimable
SPARSE_STRATUM_WARNING_SHARE = 0.25  # a variance stratum carrying >25% of the weighted domain with no within-stratum variation is flagged

EXPORT_COLUMNS_V3: List[str] = [
    "export_id", "mode", "is_pilot", "case_id", "case_version", "review_module", "unit_type", "unit_id", "nct_id",
    "descriptor_ui", "descriptor_name", "area", "determination_level", "layer",
    "analysis_set", "selection_stratum", "variance_stratum", "selection_probability", "sampling_weight",
    "variance_stratum_size", "comparison_cell_v11", "trial_frequency_weight", "policy_governed_neoplasm_GEN06",
    "original_binary", "curated_v11_status_raw", "curated_v11_binary",
    "reviewer_1_pseudo_id", "reviewer_1_decision", "reviewer_1_uncertain",
    "reviewer_2_pseudo_id", "reviewer_2_decision", "reviewer_2_uncertain",
    "double_reviewed", "reviewers_agree", "disagreement_reason_code",
    "adjudication_id", "adjudicated_decision", "adjudication_status", "adjudication_basis",
    "adjudicator_role", "adjudication_blinded", "adjudicator_exposed_to_index_labels", "post_unblinding_revision_exists",
    "ontology_version", "rubric_version", "sampling_design_version", "sample_manifest_id", "sample_manifest_sha256",
    "decision_file_v11_sha256",
]
MANIFEST_KEYS_V3 = ["export_id", "export_type", "export_format_version", "mode", "created_at", "app_git_sha",
                    "db_schema_version", "ontology_version", "rubric_version", "sampling_design_version",
                    "sample_manifest_id", "sample_manifest_sha256", "decision_file_v11_sha256",
                    "review_phase_status", "reference_locked", "files", "is_synthetic_fixture"]


class ExportError(ValueError):
    """The export breaks the v3 contract. Nothing is computed."""


class MissingResultError(KeyError):
    """A manuscript slot has no computed value. The block is not written."""


# ---------------------------------------------------------------------------
# Loading and validation
# ---------------------------------------------------------------------------

def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _as_bool(x: Any) -> Optional[bool]:
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return None
    if isinstance(x, (bool, np.bool_)):
        return bool(x)
    s = str(x).strip().lower()
    if s in ("true", "t", "1", "yes"):
        return True
    if s in ("false", "f", "0", "no"):
        return False
    if s == "":
        return None
    raise ExportError(f"not a boolean: {x!r}")


def expected_curated_binary(original_binary: str, status: str, determination_level: str,
                            stage_c_trial_decision: Optional[str] = None) -> str:
    """Operational curated v1.1 membership (CLINICAL_ONTOLOGY.yaml deterministic_mapping_policy).

    Descriptor level: INCLUDE -> INCLUDE; EXCLUDE -> EXCLUDE; NOT_IN_DECISION_FILE -> EXCLUDE;
    INSUFFICIENT_EVIDENCE and CONTEXT_DEPENDENT -> original membership retained.
    Trial level (CONTEXT_DEPENDENT descriptors): the Stage C trial decision when Stage C read the trial,
    otherwise original membership retained; the export carries the result in curated_v11_binary and
    this check only confirms it is a binary code.
    """
    if determination_level == "TRIAL_LEVEL":
        return stage_c_trial_decision if stage_c_trial_decision in (POS, NEG) else original_binary
    if status == "INCLUDE":
        return POS
    if status in ("EXCLUDE", "NOT_IN_DECISION_FILE"):
        return NEG
    if status in ("INSUFFICIENT_EVIDENCE", "CONTEXT_DEPENDENT"):
        return original_binary
    raise ExportError(f"unknown curated v1.1 status {status!r}")


def validate_export(df: pd.DataFrame, manifest: Mapping[str, Any], allow_synthetic: bool = False) -> pd.DataFrame:
    """Check the v3 contract. Raises ExportError on any breach; returns a normalized copy."""
    missing = [c for c in EXPORT_COLUMNS_V3 if c not in df.columns]
    if missing:
        raise ExportError(f"export lacks required v3 columns: {missing}")
    mk = [k for k in MANIFEST_KEYS_V3 if k not in manifest]
    if mk:
        raise ExportError(f"manifest lacks required keys: {mk}")
    if str(manifest["export_format_version"]) != EXPORT_FORMAT_VERSION_V3:
        raise ExportError(f"export_format_version {manifest['export_format_version']!r} is not {EXPORT_FORMAT_VERSION_V3}")
    if manifest["mode"] != "FORMAL":
        raise ExportError("only FORMAL exports are analysed; PILOT data never enter any statistic")
    if bool(manifest["is_synthetic_fixture"]) and not allow_synthetic:
        raise ExportError("manifest marks a synthetic fixture; pass allow_synthetic=True only in tests")
    if not bool(manifest.get("reference_locked")):
        raise ExportError("the blinded adjudicated reference is not locked; accuracy is not computed before the lock")
    d = df.copy()
    for c in ["is_pilot", "double_reviewed", "reviewers_agree", "reviewer_1_uncertain", "reviewer_2_uncertain",
              "adjudication_blinded", "adjudicator_exposed_to_index_labels", "post_unblinding_revision_exists",
              "policy_governed_neoplasm_GEN06"]:
        d[c] = [_as_bool(x) for x in d[c]]
    if (d["mode"] != "FORMAL").any() or d["is_pilot"].fillna(False).any():
        raise ExportError("PILOT rows found in a FORMAL export")
    if d["case_id"].astype(str).str.startswith(rc.PILOT_CASE_PREFIX).any():
        raise ExportError("SYN- (pilot) case IDs found in a FORMAL export")
    if d["case_id"].astype(str).str.startswith(rc.TEST_FIXTURE_CASE_PREFIX).any() and not allow_synthetic:
        raise ExportError("TESTFX- synthetic fixture rows found; not study data")
    bad = set(d["analysis_set"]) - ANALYSIS_SETS
    if bad:
        raise ExportError(f"unknown analysis_set values: {sorted(bad)}")
    bad = set(d["determination_level"]) - DETERMINATION_LEVELS
    if bad:
        raise ExportError(f"unknown determination_level values: {sorted(bad)}")
    bad = set(d["review_module"]) - REVIEW_MODULES
    if bad:
        raise ExportError(f"unknown review_module values: {sorted(bad)}")
    onto = d[d.review_module == "ONTOLOGY_AREA"]
    if not (onto["layer"] == "clinical_classification").all():
        raise ExportError("ONTOLOGY_AREA rows must be layer clinical_classification (benchmark layers live in Module B)")
    for col in ["reviewer_1_decision", "reviewer_2_decision", "adjudicated_decision"]:
        vals = set(onto[col].dropna().astype(str)) - set(L1_CODES)
        if vals:
            raise ExportError(f"{col} has codes outside the layer-1 scale: {sorted(vals)}")
    for col in ["original_binary", "curated_v11_binary"]:
        vals = set(onto[col].astype(str)) - {POS, NEG}
        if vals:
            raise ExportError(f"{col} must be INCLUDE or EXCLUDE; found {sorted(vals)}")
    vals = set(onto["curated_v11_status_raw"].astype(str)) - CURATED_STATUSES
    if vals:
        raise ExportError(f"curated_v11_status_raw has unknown statuses: {sorted(vals)}")
    # Consistency of the operational curated flag at descriptor level (logged, never silently fixed)
    dl = onto[onto.determination_level != "TRIAL_LEVEL"]
    exp = [expected_curated_binary(o, s, lvl) for o, s, lvl in zip(dl.original_binary, dl.curated_v11_status_raw, dl.determination_level)]
    mism = dl.loc[np.array(exp) != dl.curated_v11_binary.to_numpy(), "case_id"].tolist()
    if mism:
        raise ExportError(f"curated_v11_binary disagrees with the deterministic mapping policy for cases: {mism[:10]}")
    w = pd.to_numeric(d["sampling_weight"], errors="coerce")
    p = pd.to_numeric(d["selection_probability"], errors="coerce")
    if w.isna().any() or (w <= 0).any() or not np.allclose(w * p, 1.0, rtol=1e-6):
        raise ExportError("sampling_weight must equal 1 / selection_probability for every row")
    d["sampling_weight"] = w
    d["selection_probability"] = p
    d["variance_stratum_size"] = pd.to_numeric(d["variance_stratum_size"], errors="coerce")
    d["trial_frequency_weight"] = pd.to_numeric(d["trial_frequency_weight"], errors="coerce")
    dup = d.duplicated(["case_id", "determination_level", "layer"])
    if dup.any():
        raise ExportError(f"duplicate case x determination_level x layer rows: {d.loc[dup, 'case_id'].tolist()[:10]}")
    return d


def load_export(export_path: str, manifest_path: str, allow_synthetic: bool = False) -> Tuple[pd.DataFrame, Dict[str, Any]]:
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    files = {f["name"]: f for f in manifest.get("files", [])}
    name = Path(export_path).name
    if name not in files:
        raise ExportError(f"{name} is not listed in the manifest")
    got = _sha256(Path(export_path))
    if got != files[name]["sha256"]:
        raise ExportError(f"SHA-256 mismatch for {name}: manifest {files[name]['sha256']}, file {got}")
    df = pd.read_csv(export_path, dtype=str, keep_default_na=False, na_values=[""])
    if "rows" in files[name] and int(files[name]["rows"]) != len(df):
        raise ExportError(f"row count {len(df)} differs from manifest {files[name]['rows']}")
    return validate_export(df, manifest, allow_synthetic), manifest


# ---------------------------------------------------------------------------
# Reference standard and denominator rules
# ---------------------------------------------------------------------------

def reference_binary(adjudicated: Iterable[Any], rule: str = "R0_primary") -> Tuple[List[Optional[str]], Dict[str, int]]:
    """Map adjudicated layer-1 decisions to INCLUDE / EXCLUDE / None under a denominator rule."""
    if rule not in DENOMINATOR_RULES:
        raise ValueError(f"unknown denominator rule {rule!r}")
    out: List[Optional[str]] = []
    counts = {"INCLUDE": 0, "EXCLUDE": 0, "CONTEXT_DEPENDENT": 0, "INSUFFICIENT_INFORMATION": 0, "UNRESOLVED_OR_MISSING": 0}
    for x in adjudicated:
        s = None if x is None or (isinstance(x, float) and math.isnan(x)) or str(x).strip() == "" else str(x)
        if s is None:
            counts["UNRESOLVED_OR_MISSING"] += 1
            out.append(None)
            continue
        counts[s] += 1
        if s in (POS, NEG):
            out.append(s)
        elif rule == "R1_bound_nondirectional_as_include":
            out.append(POS)
        elif rule == "R2_bound_nondirectional_as_exclude":
            out.append(NEG)
        else:
            out.append(None)
    return out, counts


# ---------------------------------------------------------------------------
# Weighted estimation (wrapper around agreement_metrics.weighted_ratio)
# ---------------------------------------------------------------------------

def weighted_ratio_v3(num: Sequence[float], den: Sequence[float], weights: Sequence[float],
                      strata: Sequence[Any], stratum_sizes: Mapping[Any, float],
                      conf: float = am.DEFAULT_CONF) -> Dict[str, Any]:
    """am.weighted_ratio plus a Wilson interval at n_eff capped at the unweighted domain count.

    The capped interval is the PRIMARY weighted interval in v3. The uncapped v2 interval is kept
    in the output for transparency. A sparse-stratum warning is raised when a variance stratum
    that carries more than SPARSE_STRATUM_WARNING_SHARE of the weighted domain shows no
    within-stratum variation of the linearized variable (its variance contribution is then zero
    although its uncertainty is not).
    """
    num = np.asarray(num, float); den = np.asarray(den, float); w = np.asarray(weights, float)
    s = np.asarray(list(strata), dtype=object)
    base = am.weighted_ratio(num, den, w, s, dict(stratum_sizes), conf)
    out = dict(base)
    out["ci_low_uncapped"], out["ci_high_uncapped"] = base.get("ci_low"), base.get("ci_high")
    n_dom = int((den > 0).sum())
    out["n_domain_unweighted"] = n_dom
    r = base.get("estimate")
    if n_dom < MIN_UNITS_FOR_WEIGHTED or r is None or (isinstance(r, float) and math.isnan(r)):
        out.update({"estimable": False, "estimate": float("nan"), "ci_low": float("nan"), "ci_high": float("nan"),
                    "not_estimable_reason": f"fewer than {MIN_UNITS_FOR_WEIGHTED} units in the domain ({n_dom})"})
        return out
    if base.get("ci_estimable") is False:
        out.update({"estimable": True, "ci_estimable": False})
        return out
    n_eff = float(base.get("n_effective", n_dom))
    n_cap = min(n_eff, float(n_dom))
    z = am._z(conf)
    denom = 1 + z * z / n_cap
    center = (r + z * z / (2 * n_cap)) / denom
    half = z * math.sqrt(max(r * (1 - r), 0.0) / n_cap + z * z / (4 * n_cap * n_cap)) / denom
    out.update({"estimable": True, "n_effective_capped": n_cap, "ci_low": max(0.0, center - half),
                "ci_high": min(1.0, center + half),
                "ci_method": "Wilson at effective sample size capped at the unweighted domain count (primary); "
                             "uncapped v2 interval in ci_low_uncapped / ci_high_uncapped"})
    # sparse-stratum warning
    wden = float((w * den).sum())
    warn = []
    for h in pd.unique(s):
        m = s == h
        share = float((w[m] * den[m]).sum()) / wden if wden > 0 else 0.0
        if share > SPARSE_STRATUM_WARNING_SHARE:
            zh = (num[m] - r * den[m])
            if m.sum() < 2 or np.allclose(zh, zh.mean()):
                warn.append(str(h))
    out["sparse_stratum_warning"] = warn
    return out


# ---------------------------------------------------------------------------
# Paired comparison helpers
# ---------------------------------------------------------------------------

def newcombe_paired_difference(a: int, b: int, c: int, d: int, conf: float = am.DEFAULT_CONF) -> Dict[str, Any]:
    """Difference of two paired proportions (p1 - p2) with Newcombe's hybrid score interval (method 10).

    2 x 2 table of paired outcomes on the SAME units: a = both 1, b = first 1 second 0,
    c = first 0 second 1, d = both 0. p1 = (a + b) / n, p2 = (a + c) / n. Here "1" means the
    classifier is correct on a reference positive (sensitivity) or a reference negative (specificity).
    """
    n = a + b + c + d
    if n == 0:
        return {"estimate": float("nan"), "ci_low": float("nan"), "ci_high": float("nan"), "n": 0,
                "ci_method": "Newcombe hybrid score (paired), method 10"}
    p1, p2 = (a + b) / n, (a + c) / n
    l1, u1 = am.wilson_ci(a + b, n, conf)
    l2, u2 = am.wilson_ci(a + c, n, conf)
    diff = p1 - p2
    # correlation term (phi-hat), set to 0 when undefined (Newcombe 1998)
    den = (a + b) * (c + d) * (a + c) * (b + d)
    phi = 0.0
    if den > 0:
        num = a * d - b * c
        phi = num / math.sqrt(den)
    dl = math.sqrt(max((p1 - l1) ** 2 - 2 * phi * (p1 - l1) * (u2 - p2) + (u2 - p2) ** 2, 0.0))
    du = math.sqrt(max((u1 - p1) ** 2 - 2 * phi * (u1 - p1) * (p2 - l2) + (p2 - l2) ** 2, 0.0))
    return {"estimate": diff, "ci_low": max(-1.0, diff - dl), "ci_high": min(1.0, diff + du), "n": n,
            "a_both_correct": a, "b_first_only": b, "c_second_only": c, "d_both_wrong": d,
            "ci_method": "Newcombe hybrid score (paired), method 10"}


def weighted_paired_difference(y_first: Sequence[float], y_second: Sequence[float], den: Sequence[float],
                               weights: Sequence[float], strata: Sequence[Any], stratum_sizes: Mapping[Any, float],
                               conf: float = am.DEFAULT_CONF) -> Dict[str, Any]:
    """Weighted difference of two ratios sharing one denominator: sum w(y1 - y2) / sum w den.

    Linearized variance (stratified, with replacement within strata, FPC); normal interval truncated
    to [-1, 1]. Used for v1.1 minus original in sensitivity (den = reference positive) and specificity
    (den = reference negative).
    """
    y1 = np.asarray(y_first, float); y2 = np.asarray(y_second, float); den = np.asarray(den, float)
    w = np.asarray(weights, float); s = np.asarray(list(strata), dtype=object)
    wden = float((w * den).sum())
    n_dom = int((den > 0).sum())
    if wden <= 0 or n_dom < MIN_UNITS_FOR_WEIGHTED:
        return {"estimate": float("nan"), "ci_low": float("nan"), "ci_high": float("nan"), "estimable": False,
                "n_domain_unweighted": n_dom, "not_estimable_reason": f"fewer than {MIN_UNITS_FOR_WEIGHTED} units in the domain"}
    y = y1 - y2
    dhat = float((w * y).sum()) / wden
    unidentified = [str(h) for h in pd.unique(s) if int((s == h).sum()) == 1 and stratum_sizes.get(h) != 1]
    if unidentified:
        return {"estimate": dhat, "se": float("nan"), "ci_low": float("nan"), "ci_high": float("nan"),
                "estimable": True, "ci_estimable": False, "n_domain_unweighted": n_dom,
                "not_estimable_reason": "variance unidentified in non-census singleton strata: " + ", ".join(unidentified)}
    zi = w * (y - dhat * den) / wden
    var = 0.0
    for h in pd.unique(s):
        m = s == h
        nh = int(m.sum())
        if nh < 2:
            continue
        fpc = 1.0
        if h in stratum_sizes and stratum_sizes[h]:
            fpc = max(0.0, 1.0 - nh / float(stratum_sizes[h]))
        zh = zi[m]
        var += fpc * nh / (nh - 1) * float(((zh - zh.mean()) ** 2).sum())
    z = am._z(conf)
    se = math.sqrt(var)
    return {"estimate": dhat, "se": se, "ci_low": max(-1.0, dhat - z * se), "ci_high": min(1.0, dhat + z * se),
            "estimable": True, "n_domain_unweighted": n_dom,
            "ci_method": "stratified Taylor linearization, normal interval truncated to [-1, 1]"}


# ---------------------------------------------------------------------------
# Core analyses
# ---------------------------------------------------------------------------

def _subset(df: pd.DataFrame, module: str = "ONTOLOGY_AREA", level: str = "DESCRIPTOR_LEVEL",
            analysis_set: Optional[str] = "VALIDATION_HELDOUT") -> pd.DataFrame:
    d = df[(df.review_module == module) & (df.determination_level == level)]
    if analysis_set is not None:
        d = d[d.analysis_set == analysis_set]
    return d


def reviewer_agreement(df: pd.DataFrame) -> Dict[str, Any]:
    """Reviewer-reviewer agreement, separately by module x determination level x analysis set.

    Uses double-reviewed rows only. This is consistency between two clinicians, not accuracy.
    """
    out: Dict[str, Any] = {}
    for (module, level), g in df.groupby(["review_module", "determination_level"]):
        dr = g[g.double_reviewed.fillna(False)]
        key = f"{module}|{level}"
        res = {"n_cases": int(len(g)), "n_double_reviewed": int(len(dr)),
               "n_single_reviewed_excluded": int(len(g) - len(dr))}
        if len(dr):
            res["all_sets"] = am.agreement_summary(dr.reviewer_1_decision, dr.reviewer_2_decision, L1_CODES)
            for aset, gg in dr.groupby("analysis_set"):
                res[aset] = am.agreement_summary(gg.reviewer_1_decision, gg.reviewer_2_decision, L1_CODES)
        out[key] = res
    return out


def _binary_metrics_block(index: Sequence[str], ref: Sequence[Optional[str]], weights: np.ndarray,
                          strata: np.ndarray, sizes: Mapping[Any, float]) -> Dict[str, Any]:
    ix = np.array([str(x) if x is not None else "" for x in index])
    rf = np.array([str(x) if x is not None else "" for x in ref])
    keep = np.isin(rf, [POS, NEG]) & np.isin(ix, [POS, NEG])
    unw = am.diagnostic_accuracy(list(ix[keep]), list(rf[keep]), POS, NEG)
    acc = am.raw_agreement(list(ix[keep]), list(rf[keep]))
    kap = am.cohen_kappa(list(ix[keep]), list(rf[keep]), [POS, NEG])
    ip = (ix == POS) & keep; ineg = (ix == NEG) & keep
    rp = (rf == POS) & keep; rn = (rf == NEG) & keep
    f = lambda num, den: weighted_ratio_v3(num.astype(float), den.astype(float), weights, strata, sizes)
    wtd = {"sensitivity": f(ip & rp, rp), "specificity": f(ineg & rn, rn), "ppv": f(ip & rp, ip),
           "npv": f(ineg & rn, ineg), "binary_accuracy": f(keep & (ix == rf), keep)}
    return {"n_binary_pairs": int(keep.sum()),
            "confusion": {"tp": unw["tp"], "fp": unw["fp"], "fn": unw["fn"], "tn": unw["tn"]},
            "unweighted_sample_restricted": {"sensitivity": unw["sensitivity"], "specificity": unw["specificity"],
                                             "ppv": unw["ppv"], "npv": unw["npv"], "binary_raw_agreement": acc,
                                             "cohen_kappa_binary": {k: kap[k] for k in ("kappa", "se", "ci_low", "ci_high", "po", "pe", "n", "estimable", "reporting_reason")}},
            "design_weighted": wtd}


def classifier_vs_reference(df: pd.DataFrame, level: str = "DESCRIPTOR_LEVEL", analysis_set: str = "VALIDATION_HELDOUT",
                            rule: str = "R0_primary") -> Dict[str, Any]:
    """Original technical flags and curated v1.1 flags against the adjudicated reference, same cases."""
    d = _subset(df, level=level, analysis_set=analysis_set)
    ref, ref_counts = reference_binary(d.adjudicated_decision.tolist(), rule)
    w = d.sampling_weight.to_numpy(float)
    s = d.variance_stratum.astype(str).to_numpy()
    sizes = d.groupby("variance_stratum").variance_stratum_size.first().to_dict()
    res = {"level": level, "analysis_set": analysis_set, "denominator_rule": rule,
           "denominator_rule_text": DENOMINATOR_RULES[rule], "n_cases": int(len(d)),
           "reference_counts": ref_counts,
           "original_technical": _binary_metrics_block(d.original_binary.tolist(), ref, w, s, sizes),
           "curated_v11": _binary_metrics_block(d.curated_v11_binary.tolist(), ref, w, s, sizes)}
    # The raw status describes the descriptor stage, even on trial rows. Trial
    # accuracy uses the frozen trial binary above; it cannot use this four-category statistic.
    if level != "TRIAL_LEVEL":
        cur4 = d.curated_v11_status_raw.replace({"INSUFFICIENT_EVIDENCE": "INSUFFICIENT_INFORMATION", "NOT_IN_DECISION_FILE": "EXCLUDE"})
        ok = d.adjudicated_decision.notna()
        res["curated_v11_four_category_exact_match"] = am.exact_match_accuracy(cur4[ok].tolist(), d.adjudicated_decision[ok].tolist())
    return res


def paired_comparison(df: pd.DataFrame, level: str = "DESCRIPTOR_LEVEL", analysis_set: str = "VALIDATION_HELDOUT",
                      rule: str = "R0_primary") -> Dict[str, Any]:
    """v1.1 minus original on identical cases: discordant pairs, differences, discordant-pair accuracy. No p-values."""
    d = _subset(df, level=level, analysis_set=analysis_set)
    ref, _ = reference_binary(d.adjudicated_decision.tolist(), rule)
    rf = np.array([x if x is not None else "" for x in ref])
    o = d.original_binary.to_numpy(str); c = d.curated_v11_binary.to_numpy(str)
    keep = np.isin(rf, [POS, NEG])
    oc = (o == rf) & keep; cc = (c == rf) & keep
    out: Dict[str, Any] = {"level": level, "analysis_set": analysis_set, "denominator_rule": rule}
    disc = (o != c) & keep
    out["discordant_units"] = int(disc.sum())
    out["discordant_curated_correct"] = int((disc & cc).sum())
    out["discordant_original_correct"] = int((disc & oc).sum())
    out["discordant_pair_accuracy_curated"] = am.proportion(int((disc & cc).sum()), int(disc.sum()))
    w = d.sampling_weight.to_numpy(float); s = d.variance_stratum.astype(str).to_numpy()
    sizes = d.groupby("variance_stratum").variance_stratum_size.first().to_dict()
    out["discordant_pair_accuracy_curated_weighted"] = weighted_ratio_v3((disc & cc).astype(float), disc.astype(float), w, s, sizes)
    for metric, mask in (("sensitivity", (rf == POS) & keep), ("specificity", (rf == NEG) & keep)):
        a = int((cc & oc & mask).sum()); b = int((cc & ~oc & mask).sum())
        cnt = int((~cc & oc & mask).sum()); dd = int((~cc & ~oc & mask).sum())
        out[f"{metric}_difference_curated_minus_original"] = newcombe_paired_difference(a, b, cnt, dd)
        out[f"{metric}_difference_curated_minus_original_weighted"] = weighted_paired_difference(
            (cc & mask).astype(float), (oc & mask).astype(float), mask.astype(float), w, s, sizes)
    return out


def per_area(df: pd.DataFrame, level: str = "DESCRIPTOR_LEVEL", analysis_set: str = "VALIDATION_HELDOUT",
             threshold: int = MIN_AREA_DENOMINATOR) -> Dict[str, Any]:
    """Unweighted per-area metrics, reported only where the denominator reaches the threshold."""
    d = _subset(df, level=level, analysis_set=analysis_set)
    out: Dict[str, Any] = {"threshold": threshold, "areas": {}}
    for area, g in d.groupby("area"):
        ref, counts = reference_binary(g.adjudicated_decision.tolist())
        rf = np.array([x if x is not None else "" for x in ref])
        entry: Dict[str, Any] = {"n_cases": int(len(g)), "reference_counts": counts}
        for cname, col in (("original_technical", "original_binary"), ("curated_v11", "curated_v11_binary")):
            ix = g[col].to_numpy(str)
            keep = np.isin(rf, [POS, NEG])
            m = am.diagnostic_accuracy(list(ix[keep]), list(rf[keep]), POS, NEG)
            block = {}
            for metric, den in (("sensitivity", m["tp"] + m["fn"]), ("specificity", m["tn"] + m["fp"]),
                                ("ppv", m["tp"] + m["fp"]), ("npv", m["tn"] + m["fn"])):
                block[metric] = m[metric] if den >= threshold else {"reported": False, "denominator": int(den),
                                                                     "reason": f"denominator below prespecified threshold {threshold}"}
            block["confusion"] = {k: m[k] for k in ("tp", "fp", "fn", "tn")}
            entry[cname] = block
        out["areas"][area] = entry
    return out


def disagreement_summary(df: pd.DataFrame) -> Dict[str, Any]:
    d = df[(df.review_module == "ONTOLOGY_AREA") & df.double_reviewed.fillna(False) & (df.reviewers_agree == False)]  # noqa: E712
    out = {}
    for level, g in d.groupby("determination_level"):
        codes = g.disagreement_reason_code.fillna("NOT_RECORDED").astype(str)
        unknown = set(codes) - set(DISAGREEMENT_REASONS) - {"NOT_RECORDED"}
        if unknown:
            raise ExportError(f"unknown disagreement reason codes: {sorted(unknown)}")
        out[level] = {"n_disagreements": int(len(g)), "by_reason": codes.value_counts().to_dict(),
                      "by_area": g.area.value_counts().to_dict()}
    return out


def trial_two_step_summary(df: pd.DataFrame) -> Dict[str, Any]:
    """Descriptor-level step (recorded before the trial packet opens) versus the trial-level determination."""
    t = df[(df.review_module == "ONTOLOGY_AREA") & (df.unit_type == "TRIAL_AREA")]
    step1 = t[t.determination_level == "DESCRIPTOR_LEVEL_IN_TRIAL_CASE"].set_index("case_id")
    step2 = t[t.determination_level == "TRIAL_LEVEL"].set_index("case_id")
    common = step1.index.intersection(step2.index)
    out = {"n_trial_cases": int(len(step2)), "n_with_both_steps": int(len(common))}
    if len(common):
        for slot in ("reviewer_1", "reviewer_2"):
            a = step1.loc[common, f"{slot}_decision"].fillna("MISSING")
            b = step2.loc[common, f"{slot}_decision"].fillna("MISSING")
            out[f"{slot}_step1_by_step2"] = pd.crosstab(a, b).to_dict()
        ref1 = step1.loc[common, "adjudicated_decision"].fillna("UNRESOLVED")
        out["adjudicated_step1_context_dependent_resolved_at_trial_level"] = int(
            ((ref1 == "CONTEXT_DEPENDENT") & step2.loc[common, "adjudicated_decision"].isin([POS, NEG])).sum())
    return out


def uncertainty_summary(df: pd.DataFrame) -> Dict[str, Any]:
    d = df[df.review_module == "ONTOLOGY_AREA"]
    out = {}
    for level, g in d.groupby("determination_level"):
        u1 = g.reviewer_1_uncertain.fillna(False); u2 = g.reviewer_2_uncertain.fillna(False)
        out[level] = {"n": int(len(g)), "either_uncertain": int((u1 | u2).sum()), "both_uncertain": int((u1 & u2).sum())}
    return out


def blinding_summary(df: pd.DataFrame) -> Dict[str, Any]:
    d = df[(df.review_module == "ONTOLOGY_AREA") & df.adjudicated_decision.notna()]
    return {"n_adjudicated": int(len(d)),
            "adjudicator_role_counts": d.adjudicator_role.fillna("NONE").value_counts().to_dict(),
            "n_blinded_adjudications": int(d.adjudication_blinded.fillna(False).sum()),
            "n_adjudicator_exposed_to_index_labels": int(d.adjudicator_exposed_to_index_labels.fillna(False).sum()),
            "n_with_post_unblinding_revision": int(d.post_unblinding_revision_exists.fillna(False).sum()),
            "note": "The primary reference is the last BLINDED adjudication; post-unblinding revisions are reported, never substituted."}


def build_results(df: pd.DataFrame, manifest: Mapping[str, Any]) -> Dict[str, Any]:
    raise ExportError("Legacy direct analysis disabled; use synthetic-only v4 entry point")


# ---------------------------------------------------------------------------
# Manuscript block generator
# ---------------------------------------------------------------------------

def _get(res: Mapping[str, Any], path: str) -> Any:
    cur: Any = res
    for part in path.split("."):
        if isinstance(cur, Mapping) and part in cur:
            cur = cur[part]
        else:
            raise MissingResultError(path)
    return cur


def _fmt_prop(x: Any) -> str:
    return f"{100 * float(x):.1f}%"


def _fmt_ci(lo: Any, hi: Any, pct: bool = True) -> str:
    if pct:
        return f"{100 * float(lo):.1f}% to {100 * float(hi):.1f}%"
    return f"{float(lo):.2f} to {float(hi):.2f}"


# slot -> (path in results, formatter). Formatters never invent values: they only format what the path holds.
DESC = "accuracy.DESCRIPTOR_LEVEL.R0_primary"
PAIR = "paired_comparison.DESCRIPTOR_LEVEL"
RA = "reviewer_agreement.ONTOLOGY_AREA|DESCRIPTOR_LEVEL"
SLOT_MAP: Dict[str, Tuple[str, str]] = {
    "N_DOUBLE_REVIEWED_DESCRIPTOR": (f"{RA}.n_double_reviewed", "int"),
    "RAW_AGREEMENT_DESCRIPTOR": (f"{RA}.all_sets.raw_agreement.estimate", "pct"),
    "RAW_AGREEMENT_DESCRIPTOR_CI": (f"{RA}.all_sets.raw_agreement", "ci_pct"),
    "KAPPA_DESCRIPTOR": (f"{RA}.all_sets.kappa.kappa", "num2"),
    "KAPPA_DESCRIPTOR_CI": (f"{RA}.all_sets.kappa", "ci_num"),
    "N_VALIDATION_DESCRIPTOR": (f"{DESC}.n_cases", "int"),
    "N_VALIDATION_BINARY": (f"{DESC}.curated_v11.n_binary_pairs", "int"),
    "N_REFERENCE_NONDIRECTIONAL": (f"{DESC}.reference_counts", "nondir"),
    "SENS_ORIGINAL_W": (f"{DESC}.original_technical.design_weighted.sensitivity", "est_ci_pct"),
    "SENS_CURATED_W": (f"{DESC}.curated_v11.design_weighted.sensitivity", "est_ci_pct"),
    "PPV_ORIGINAL_W": (f"{DESC}.original_technical.design_weighted.ppv", "est_ci_pct"),
    "PPV_CURATED_W": (f"{DESC}.curated_v11.design_weighted.ppv", "est_ci_pct"),
    "SPEC_ORIGINAL_W": (f"{DESC}.original_technical.design_weighted.specificity", "est_ci_pct"),
    "SPEC_CURATED_W": (f"{DESC}.curated_v11.design_weighted.specificity", "est_ci_pct"),
    "N_DISCORDANT": (f"{PAIR}.discordant_units", "int"),
    "N_DISCORDANT_CURATED_CORRECT": (f"{PAIR}.discordant_curated_correct", "int"),
    "N_DISCORDANT_ORIGINAL_CORRECT": (f"{PAIR}.discordant_original_correct", "int"),
    "N_DEVELOPMENT_CASES": ("counts.cases_by_analysis_set.DEVELOPMENT_KNOWN_ISSUE", "int"),
}


def _format(kind: str, v: Any) -> str:
    if kind == "int":
        return f"{int(v):,}"
    if kind == "pct":
        if v is None or (isinstance(v, float) and math.isnan(v)):
            raise MissingResultError("value is NaN")
        return _fmt_prop(v)
    if kind == "num2":
        if v is None or (isinstance(v, float) and math.isnan(v)):
            raise MissingResultError("value is NaN")
        return f"{float(v):.2f}"
    if kind == "ci_pct":
        if any(v.get(k) is None or (isinstance(v.get(k), float) and math.isnan(v.get(k))) for k in ("ci_low", "ci_high")):
            raise MissingResultError("interval is NaN")
        return _fmt_ci(v["ci_low"], v["ci_high"], True)
    if kind == "ci_num":
        if any(v.get(k) is None or (isinstance(v.get(k), float) and math.isnan(v.get(k))) for k in ("ci_low", "ci_high")):
            raise MissingResultError("interval is NaN")
        return _fmt_ci(v["ci_low"], v["ci_high"], False)
    if kind == "est_ci_pct":
        if not v.get("estimable", True) or any(isinstance(v.get(k), float) and math.isnan(v.get(k)) for k in ("estimate", "ci_low", "ci_high")):
            raise MissingResultError("weighted estimate not estimable")
        return f"{_fmt_prop(v['estimate'])} (95% CI, {_fmt_ci(v['ci_low'], v['ci_high'])})"
    if kind == "nondir":
        return f"{int(v['CONTEXT_DEPENDENT']) + int(v['INSUFFICIENT_INFORMATION']):,}"
    raise ValueError(kind)


def render_manuscript_block(results: Mapping[str, Any], template: str, allow_synthetic: bool = False) -> Tuple[str, pd.DataFrame]:
    """Fill {{SLOT}} markers in the template from computed results only.

    Raises MissingResultError when any slot in the template has no computed, finite value.
    Returns the block and a trace table (slot, results path, value).
    """
    if results.get("is_synthetic_fixture") is not True:
        raise ExportError("SYNTHETIC ENGINEERING ONLY: clinical result rendering disabled")
    if results.get("is_synthetic_fixture") and not allow_synthetic:
        raise ExportError("results come from a synthetic fixture; refusing to render a manuscript block")
    slots = sorted(set(re.findall(r"\{\{([A-Z0-9_]+)\}\}", template)))
    trace, filled = [], template
    for slot in slots:
        if slot not in SLOT_MAP:
            raise MissingResultError(f"template slot {slot} is not defined in SLOT_MAP")
        path, kind = SLOT_MAP[slot]
        value = _get(results, path)
        text = _format(kind, value)
        trace.append({"slot": slot, "results_path": path, "rendered": text})
        filled = filled.replace("{{" + slot + "}}", text)
    if re.search(r"\{\{[A-Z0-9_]+\}\}", filled):
        raise MissingResultError("unfilled slots remain")
    if results.get("is_synthetic_fixture"):
        filled = "SYNTHETIC TEST OUTPUT. NOT STUDY RESULTS.\n\n" + filled
    return filled, pd.DataFrame(trace)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _jsonable(o: Any) -> Any:
    if isinstance(o, dict):
        return {str(k): _jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_jsonable(v) for v in o]
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return None if math.isnan(float(o)) else float(o)
    if isinstance(o, float) and math.isnan(o):
        return None
    if isinstance(o, (np.bool_,)):
        return bool(o)
    return o


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--export", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--template")
    ap.add_argument("--allow-synthetic", action="store_true")
    a = ap.parse_args(argv)
    df, manifest = load_export(a.export, a.manifest, a.allow_synthetic)
    res = build_results(df, manifest)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "performance_results_v3.json").write_text(json.dumps(_jsonable(res), indent=2, sort_keys=True), encoding="utf-8")
    if a.template:
        block, trace = render_manuscript_block(res, Path(a.template).read_text(encoding="utf-8"), a.allow_synthetic)
        (out / "clinical_review_results_block_v3.md").write_text(block, encoding="utf-8")
        trace.to_csv(out / "clinical_review_results_block_v3_trace.csv", index=False)
    print(f"wrote {out / 'performance_results_v3.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
