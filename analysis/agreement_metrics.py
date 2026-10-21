"""SYNTHETIC ENGINEERING ONLY. Proposed analysis; no clinical study results."""

from __future__ import annotations

import math
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

import numpy as np
import pandas as pd
from scipy.stats import norm

__version__ = "1.0.0"

DEFAULT_SEED = 20261013
DEFAULT_BOOTSTRAP_REPS = 2000
DEFAULT_CONF = 0.95

# Prespecified rule for when Cohen's kappa is the primary agreement statistic
# (VALIDATION_PLAN.md, section "Kappa reporting rule"). Kappa is primary only
# when it is defined, at least two response categories are each used at least
# MIN_CATEGORY_N times by BOTH reviewers, and expected agreement does not exceed
# MAX_PE_FOR_PRIMARY. Otherwise raw agreement is primary, PABAK and AC1 are
# reported alongside, and kappa (if defined) is shown as secondary.
MIN_CATEGORY_N = 5
MAX_PE_FOR_PRIMARY = 0.80


# ---------------------------------------------------------------------------
# Basic helpers
# ---------------------------------------------------------------------------

def _z(conf: float) -> float:
    """Two-sided standard normal quantile for a confidence level."""
    if not 0 < conf < 1:
        raise ValueError(f"conf must be in (0, 1); got {conf}")
    return float(norm.ppf(1 - (1 - conf) / 2))


def _nan() -> float:
    return float("nan")


def _truthy(x: Any) -> float:
    """1.0 for True-like values (True, 1, 1.0, 'true', 'yes'), else 0.0. Missing is 0.0."""
    if x is None:
        return 0.0
    if isinstance(x, (bool, np.bool_)):
        return float(bool(x))
    if isinstance(x, (int, float, np.integer, np.floating)):
        return 0.0 if (isinstance(x, (float, np.floating)) and math.isnan(x)) else float(x != 0)
    return 1.0 if str(x).strip().lower() in ("1", "1.0", "true", "t", "yes", "y") else 0.0


def wilson_ci(successes: int, n: int, conf: float = DEFAULT_CONF) -> Tuple[float, float]:
    """Wilson score interval for successes out of n. Returns (nan, nan) if n == 0."""
    if n is None or n <= 0:
        return (_nan(), _nan())
    if successes < 0 or successes > n:
        raise ValueError(f"successes={successes} outside [0, n={n}]")
    z = _z(conf)
    p = successes / n
    denom = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    lo = 0.0 if successes == 0 else max(0.0, center - half)
    hi = 1.0 if successes == n else min(1.0, center + half)
    return (lo, hi)


def wilson_half_width(p: float, n: int, conf: float = DEFAULT_CONF) -> float:
    """Half-width of the Wilson interval at an assumed proportion p (planning use)."""
    z = _z(conf)
    denom = 1 + z * z / n
    return z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom


def proportion(successes: int, n: int, conf: float = DEFAULT_CONF) -> Dict[str, Any]:
    """A proportion with its Wilson interval, as a plain dict."""
    lo, hi = wilson_ci(successes, n, conf)
    return {
        "x": int(successes),
        "n": int(n),
        "estimate": (successes / n) if n else _nan(),
        "ci_low": lo,
        "ci_high": hi,
        "ci_method": "Wilson score",
        "conf_level": conf,
    }


def _as_object_array(values: Iterable[Any]) -> pd.Series:
    s = pd.Series(list(values), dtype="object")
    # Treat empty strings as missing; they are never a valid response code.
    return s.where(~s.astype(str).str.strip().isin(["", "nan", "None", "NaN"]), None)


def paired_labels(r1: Iterable[Any], r2: Iterable[Any]) -> Tuple[np.ndarray, np.ndarray, int]:
    """Align two label sequences, keep complete pairs, and count excluded pairs."""
    a = _as_object_array(r1)
    b = _as_object_array(r2)
    if len(a) != len(b):
        raise ValueError(f"label sequences differ in length: {len(a)} vs {len(b)}")
    ok = a.notna() & b.notna()
    return a[ok].astype(str).to_numpy(), b[ok].astype(str).to_numpy(), int((~ok).sum())


# ---------------------------------------------------------------------------
# Agreement between two raters
# ---------------------------------------------------------------------------

def raw_agreement(r1: Iterable[Any], r2: Iterable[Any], conf: float = DEFAULT_CONF) -> Dict[str, Any]:
    """Observed (raw) agreement x/n with a Wilson interval, complete pairs only."""
    a, b, n_excl = paired_labels(r1, r2)
    out = proportion(int((a == b).sum()), len(a), conf)
    out["n_pairs_excluded_missing"] = n_excl
    out["statistic"] = "raw_agreement"
    return out


def contingency_table(r1: Iterable[Any], r2: Iterable[Any],
                      categories: Optional[Sequence[str]] = None) -> pd.DataFrame:
    """Square rater-1 by rater-2 count table over the given (or observed) categories.

    Labels outside `categories` raise an error instead of being dropped, so an
    unexpected code is always visible.
    """
    a, b, _ = paired_labels(r1, r2)
    cats = list(categories) if categories is not None else sorted(set(a) | set(b))
    unknown = (set(a) | set(b)) - set(cats)
    if unknown:
        raise ValueError(f"labels not in the category set: {sorted(unknown)}")
    pos = {c: i for i, c in enumerate(cats)}
    m = np.zeros((len(cats), len(cats)), dtype=int)
    for x, y in zip(a, b):
        m[pos[x], pos[y]] += 1
    return pd.DataFrame(m, index=pd.Index(cats, name="rater_1"),
                        columns=pd.Index(cats, name="rater_2"))


def _kappa_parts(m: np.ndarray) -> Tuple[float, float, float]:
    """Return (po, pe, kappa) from a square count matrix; kappa is nan if pe == 1."""
    n = m.sum()
    if n == 0:
        return _nan(), _nan(), _nan()
    p = m / n
    po = float(np.trace(p))
    pe = float((p.sum(axis=1) * p.sum(axis=0)).sum())
    if math.isclose(pe, 1.0, rel_tol=0, abs_tol=1e-12):
        return po, pe, _nan()
    return po, pe, (po - pe) / (1 - pe)


def _kappa_se_fce(m: np.ndarray, kappa: float, pe: float) -> float:
    """Large-sample SE of kappa (Fleiss, Cohen and Everitt 1969), non-null form."""
    n = m.sum()
    p = m / n
    row = p.sum(axis=1)
    col = p.sum(axis=0)
    k = len(row)
    term1 = sum(p[i, i] * (1 - (row[i] + col[i]) * (1 - kappa)) ** 2 for i in range(k))
    term2 = (1 - kappa) ** 2 * sum(
        p[i, j] * (col[i] + row[j]) ** 2 for i in range(k) for j in range(k) if i != j
    )
    term3 = (kappa - pe * (1 - kappa)) ** 2
    var = (term1 + term2 - term3) / (n * (1 - pe) ** 2)
    return math.sqrt(max(var, 0.0))


def _category_usage(m: np.ndarray, min_n: int) -> int:
    """Number of categories used at least min_n times by BOTH raters."""
    rows = m.sum(axis=1)
    cols = m.sum(axis=0)
    return int(((rows >= min_n) & (cols >= min_n)).sum())


def cohen_kappa(r1: Iterable[Any], r2: Iterable[Any],
                categories: Optional[Sequence[str]] = None,
                conf: float = DEFAULT_CONF,
                min_category_n: int = MIN_CATEGORY_N,
                max_pe_for_primary: float = MAX_PE_FOR_PRIMARY) -> Dict[str, Any]:
    """Unweighted Cohen's kappa with the Fleiss-Cohen-Everitt analytic interval.

    Also applies the prespecified reporting rule and returns
    `kappa_primary_recommended` with a plain-language reason.
    """
    tab = contingency_table(r1, r2, categories)
    m = tab.to_numpy()
    n = int(m.sum())
    po, pe, kappa = _kappa_parts(m)
    out: Dict[str, Any] = {
        "statistic": "cohen_kappa_unweighted",
        "n": n,
        "po": po,
        "pe": pe,
        "kappa": kappa,
        "se": _nan(),
        "ci_low": _nan(),
        "ci_high": _nan(),
        "ci_method": "Fleiss-Cohen-Everitt large-sample SE, normal approximation, truncated to [-1, 1]",
        "conf_level": conf,
        "categories": list(tab.index),
        "table": tab.to_dict(orient="split"),
        "estimable": False,
        "estimability_reason": "",
        "n_categories_used_by_both_at_min_n": _category_usage(m, min_category_n) if n else 0,
        "min_category_n": min_category_n,
        "max_pe_for_primary": max_pe_for_primary,
        "kappa_primary_recommended": False,
        "reporting_reason": "",
        "secondary_reasons": [],
    }
    if n == 0:
        out["estimability_reason"] = "no complete reviewer pairs"
        out["reporting_reason"] = "no data"
        return out
    if math.isnan(kappa):
        out["estimability_reason"] = ("expected agreement equals 1 (both reviewers used one and "
                                      "the same category for every case); kappa is undefined")
        out["reporting_reason"] = "kappa undefined; report raw agreement, PABAK and AC1"
        out["secondary_reasons"] = ["kappa is undefined because both reviewers used a single, identical "
                                    "category for every case"]
        return out
    se = _kappa_se_fce(m, kappa, pe)
    z = _z(conf)
    out.update({
        "estimable": True,
        "estimability_reason": "defined",
        "se": se,
        "ci_low": max(-1.0, kappa - z * se),
        "ci_high": min(1.0, kappa + z * se),
    })
    reasons = []
    if out["n_categories_used_by_both_at_min_n"] < 2:
        reasons.append(f"fewer than two response categories were used at least {min_category_n} times "
                       f"by both reviewers")
    if pe > max_pe_for_primary:
        reasons.append(f"expected chance agreement was {pe:.2f}, above the prespecified limit of "
                       f"{max_pe_for_primary:.2f}")
    out["secondary_reasons"] = reasons
    if reasons:
        out["reporting_reason"] = ("kappa secondary: " + "; ".join(reasons) +
                                   "; report raw agreement as primary with PABAK and AC1")
    else:
        out["kappa_primary_recommended"] = True
        out["reporting_reason"] = "kappa primary: defined, adequate category use, expected agreement within limit"
    return out


def pabak(r1: Iterable[Any], r2: Iterable[Any], categories: Sequence[str],
          conf: float = DEFAULT_CONF) -> Dict[str, Any]:
    """Prevalence-adjusted bias-adjusted kappa for k = len(categories) categories.

    PABAK = (k * po - 1) / (k - 1). It is a linear function of po, so the
    interval is the Wilson interval of po mapped through the same function.
    `categories` must be the full response scale, not only the observed codes.
    """
    k = len(categories)
    if k < 2:
        raise ValueError("PABAK needs at least two categories on the response scale")
    contingency_table(r1, r2, categories)  # validates labels
    ra = raw_agreement(r1, r2, conf)
    f = lambda x: (k * x - 1) / (k - 1)
    est = f(ra["estimate"]) if ra["n"] else _nan()
    return {
        "statistic": "pabak",
        "k_categories": k,
        "n": ra["n"],
        "po": ra["estimate"],
        "pabak": est,
        "ci_low": f(ra["ci_low"]) if ra["n"] else _nan(),
        "ci_high": f(ra["ci_high"]) if ra["n"] else _nan(),
        "ci_method": "Wilson interval of observed agreement, linearly transformed",
        "conf_level": conf,
    }


def _ac1_parts(m: np.ndarray, k: int) -> Tuple[float, float, float]:
    """Return (po, pe, ac1) from a square count matrix over k scale categories."""
    n = m.sum()
    if n == 0 or k < 2:
        return _nan(), _nan(), _nan()
    p = m / n
    po = float(np.trace(p))
    pi = (p.sum(axis=1) + p.sum(axis=0)) / 2
    pe = float((pi * (1 - pi)).sum() / (k - 1))
    ac1 = (po - pe) / (1 - pe) if not math.isclose(pe, 1.0) else _nan()
    return po, pe, ac1


def gwet_ac1(r1: Iterable[Any], r2: Iterable[Any], categories: Sequence[str]) -> Dict[str, Any]:
    """Gwet's AC1 for two raters over the full response scale `categories`."""
    tab = contingency_table(r1, r2, categories)
    m = tab.to_numpy()
    k = len(categories)
    po, pe, ac1 = _ac1_parts(m, k)
    return {"statistic": "gwet_ac1", "n": int(m.sum()), "k_categories": k, "po": po, "pe": pe, "ac1": ac1}


# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------

def _bootstrap_indices(n: int, rng: np.random.Generator,
                       strata: Optional[np.ndarray]) -> np.ndarray:
    if strata is None:
        return rng.integers(0, n, size=n)
    out = []
    for h in pd.unique(strata):
        idx = np.flatnonzero(strata == h)
        out.append(idx[rng.integers(0, len(idx), size=len(idx))])
    return np.concatenate(out)


def bootstrap_ci(stat_fn: Callable[[np.ndarray], float], n: int,
                 reps: int = DEFAULT_BOOTSTRAP_REPS, seed: int = DEFAULT_SEED,
                 strata: Optional[Sequence[Any]] = None,
                 conf: float = DEFAULT_CONF) -> Dict[str, Any]:
    """Percentile bootstrap interval for stat_fn(index_array) over n cases.

    stat_fn receives an integer index array (a resample of 0..n-1) and returns a
    float; nan replicates (statistic undefined in that resample) are counted and
    excluded from the percentile calculation.
    """
    if n == 0:
        return {"ci_low": _nan(), "ci_high": _nan(), "reps": reps, "reps_undefined": 0,
                "seed": seed, "ci_method": "percentile bootstrap", "numpy_version": np.__version__}
    rng = np.random.default_rng(seed)
    strata_arr = None if strata is None else np.asarray(list(strata), dtype=object)
    vals: List[float] = []
    undefined = 0
    for _ in range(reps):
        v = stat_fn(_bootstrap_indices(n, rng, strata_arr))
        if v is None or (isinstance(v, float) and math.isnan(v)):
            undefined += 1
        else:
            vals.append(float(v))
    alpha = 1 - conf
    if vals:
        lo, hi = np.quantile(vals, [alpha / 2, 1 - alpha / 2])
    else:
        lo = hi = _nan()
    return {
        "ci_low": float(lo), "ci_high": float(hi), "reps": reps, "reps_undefined": undefined,
        "seed": seed, "stratified": strata is not None,
        "ci_method": "percentile bootstrap" + (" (resampling within strata)" if strata is not None else ""),
        "conf_level": conf, "numpy_version": np.__version__,
    }


def kappa_bootstrap_ci(r1: Iterable[Any], r2: Iterable[Any],
                       categories: Optional[Sequence[str]] = None,
                       reps: int = DEFAULT_BOOTSTRAP_REPS, seed: int = DEFAULT_SEED,
                       strata: Optional[Sequence[Any]] = None,
                       conf: float = DEFAULT_CONF) -> Dict[str, Any]:
    """Percentile bootstrap interval for Cohen's kappa (complete pairs only)."""
    a_all = _as_object_array(r1)
    b_all = _as_object_array(r2)
    ok = (a_all.notna() & b_all.notna()).to_numpy()
    a = a_all[ok].astype(str).to_numpy()
    b = b_all[ok].astype(str).to_numpy()
    s = None if strata is None else np.asarray(list(strata), dtype=object)[ok]
    cats = list(categories) if categories is not None else sorted(set(a) | set(b))
    pos = {c: i for i, c in enumerate(cats)}
    ai = np.array([pos[x] for x in a], dtype=int)
    bi = np.array([pos[x] for x in b], dtype=int)
    k = len(cats)

    def stat(idx: np.ndarray) -> float:
        m = np.zeros((k, k), dtype=int)
        np.add.at(m, (ai[idx], bi[idx]), 1)
        return _kappa_parts(m)[2]

    out = bootstrap_ci(stat, len(a), reps, seed, s, conf)
    out["statistic"] = "cohen_kappa_unweighted"
    return out


def ac1_bootstrap_ci(r1: Iterable[Any], r2: Iterable[Any], categories: Sequence[str],
                     reps: int = DEFAULT_BOOTSTRAP_REPS, seed: int = DEFAULT_SEED,
                     strata: Optional[Sequence[Any]] = None,
                     conf: float = DEFAULT_CONF) -> Dict[str, Any]:
    """Percentile bootstrap interval for Gwet's AC1 (complete pairs only)."""
    a_all = _as_object_array(r1)
    b_all = _as_object_array(r2)
    ok = (a_all.notna() & b_all.notna()).to_numpy()
    a = a_all[ok].astype(str).to_numpy()
    b = b_all[ok].astype(str).to_numpy()
    s = None if strata is None else np.asarray(list(strata), dtype=object)[ok]
    contingency_table(a, b, categories)  # validates labels against the scale
    pos = {c: i for i, c in enumerate(categories)}
    ai = np.array([pos[x] for x in a], dtype=int)
    bi = np.array([pos[x] for x in b], dtype=int)
    k = len(categories)

    def stat(idx: np.ndarray) -> float:
        m = np.zeros((k, k), dtype=int)
        np.add.at(m, (ai[idx], bi[idx]), 1)
        return _ac1_parts(m, k)[2]

    out = bootstrap_ci(stat, len(a), reps, seed, s, conf)
    out["statistic"] = "gwet_ac1"
    return out


def agreement_summary(r1: Iterable[Any], r2: Iterable[Any], categories: Sequence[str],
                      strata: Optional[Sequence[Any]] = None,
                      reps: int = DEFAULT_BOOTSTRAP_REPS, seed: int = DEFAULT_SEED,
                      conf: float = DEFAULT_CONF) -> Dict[str, Any]:
    """All prespecified two-rater statistics in one dict (used by the fill script)."""
    r1 = list(r1)
    r2 = list(r2)
    k = cohen_kappa(r1, r2, categories, conf)
    return {
        "raw_agreement": raw_agreement(r1, r2, conf),
        "kappa": k,
        "kappa_bootstrap": kappa_bootstrap_ci(r1, r2, categories, reps, seed, strata, conf),
        "pabak": pabak(r1, r2, categories, conf),
        "ac1": gwet_ac1(r1, r2, categories),
        "ac1_bootstrap": ac1_bootstrap_ci(r1, r2, categories, reps, seed, strata, conf),
        "primary_statistic": "cohen_kappa" if k["kappa_primary_recommended"] else "raw_agreement_with_pabak_ac1",
    }


# ---------------------------------------------------------------------------
# Accuracy against an adjudicated reference decision
# ---------------------------------------------------------------------------

def diagnostic_accuracy(index: Iterable[Any], reference: Iterable[Any],
                        positive: str, negative: str,
                        conf: float = DEFAULT_CONF) -> Dict[str, Any]:
    """Sensitivity, specificity, PPV, NPV, FPR and FNR with Wilson intervals.

    `index` is the decision being evaluated (for example the AI-proposed or the
    original MeSH-based decision); `reference` is the adjudicated decision.
    Only pairs where BOTH are binary (positive or negative) enter the 2 x 2
    table. Pairs with CONTEXT_DEPENDENT, INSUFFICIENT_INFORMATION or missing
    values are counted in `excluded` by reason, never dropped silently.
    """
    i_all = _as_object_array(index)
    r_all = _as_object_array(reference)
    if len(i_all) != len(r_all):
        raise ValueError("index and reference differ in length")
    binary = {positive, negative}
    excluded = {"missing_index": 0, "missing_reference": 0,
                "nonbinary_index": 0, "nonbinary_reference": 0}
    keep = []
    for x, y in zip(i_all, r_all):
        if x is None:
            excluded["missing_index"] += 1
        elif y is None:
            excluded["missing_reference"] += 1
        elif str(y) not in binary:
            excluded["nonbinary_reference"] += 1
        elif str(x) not in binary:
            excluded["nonbinary_index"] += 1
        else:
            keep.append((str(x), str(y)))
    tp = sum(1 for x, y in keep if x == positive and y == positive)
    fp = sum(1 for x, y in keep if x == positive and y == negative)
    fn = sum(1 for x, y in keep if x == negative and y == positive)
    tn = sum(1 for x, y in keep if x == negative and y == negative)
    return {
        "positive_label": positive, "negative_label": negative,
        "tp": tp, "fp": fp, "fn": fn, "tn": tn, "n_binary_pairs": len(keep),
        "excluded": excluded,
        "sensitivity": proportion(tp, tp + fn, conf),
        "specificity": proportion(tn, tn + fp, conf),
        "ppv": proportion(tp, tp + fp, conf),
        "npv": proportion(tn, tn + fn, conf),
        "false_positive_rate": proportion(fp, fp + tn, conf),
        "false_negative_rate": proportion(fn, fn + tp, conf),
    }


def exact_match_accuracy(index: Iterable[Any], reference: Iterable[Any],
                         conf: float = DEFAULT_CONF) -> Dict[str, Any]:
    """Proportion of cases where the index decision equals the reference decision
    on the full four-option scale (complete pairs only)."""
    out = raw_agreement(index, reference, conf)
    out["statistic"] = "exact_match_accuracy"
    return out


# ---------------------------------------------------------------------------
# Weighted (design-based) estimation
# ---------------------------------------------------------------------------

def _strata_array(strata: Optional[Sequence[Any]], n: int) -> np.ndarray:
    if strata is None:
        return np.zeros(n, dtype=object)
    s = np.asarray(list(strata), dtype=object)
    if len(s) != n:
        raise ValueError("strata length mismatch")
    return s


def weighted_ratio(numerator: Sequence[float], denominator: Sequence[float],
                   weights: Sequence[float], strata: Optional[Sequence[Any]] = None,
                   stratum_sizes: Optional[Mapping[Any, float]] = None,
                   conf: float = DEFAULT_CONF) -> Dict[str, Any]:
    """Hajek-type ratio estimate R = sum(w * num) / sum(w * den).

    Variance: stratified Taylor linearization treating each sampled case as its
    own primary sampling unit, with-replacement within strata, optionally with
    the finite population correction (1 - n_h / N_h) when stratum_sizes gives
    N_h. Interval: Wilson interval at the Kish-type effective sample size
    n_eff = R(1 - R) / var (for R in (0, 1)); for R equal to 0 or 1 the
    unweighted domain count is used as n_eff. Strata with one sampled case
    contribute zero variance and are reported in `singleton_strata`.
    """
    num = np.asarray(numerator, dtype=float)
    den = np.asarray(denominator, dtype=float)
    w = np.asarray(weights, dtype=float)
    n = len(w)
    if not (len(num) == len(den) == n):
        raise ValueError("numerator, denominator and weights differ in length")
    if np.any(~np.isfinite(w)) or np.any(w <= 0):
        raise ValueError("weights must be finite and positive (1 / selection probability)")
    s = _strata_array(strata, n)
    wden = float((w * den).sum())
    out: Dict[str, Any] = {"estimate": _nan(), "se": _nan(), "ci_low": _nan(), "ci_high": _nan(),
                           "n_cases": n, "n_domain_unweighted": int((den > 0).sum()),
                           "weighted_denominator": wden, "singleton_strata": [],
                           "variance_method": "stratified Taylor linearization (with replacement within strata"
                                              + (", with FPC" if stratum_sizes else "") + ")",
                           "ci_method": "Wilson at effective sample size", "conf_level": conf}
    if wden <= 0:
        return out
    r = float((w * num).sum()) / wden
    z_i = w * (num - r * den) / wden
    var = 0.0
    singletons = []
    for h in pd.unique(s):
        mask = s == h
        n_h = int(mask.sum())
        if n_h < 2:
            singletons.append(h)
            continue
        zh = z_i[mask]
        fpc = 1.0
        if stratum_sizes is not None and h in stratum_sizes and stratum_sizes[h]:
            fpc = max(0.0, 1.0 - n_h / float(stratum_sizes[h]))
        var += fpc * n_h / (n_h - 1) * float(((zh - zh.mean()) ** 2).sum())
    se = math.sqrt(var)
    if 0 < r < 1 and var > 0:
        n_eff = r * (1 - r) / var
    else:
        n_eff = float(out["n_domain_unweighted"])
    if n_eff > 0:
        z = _z(conf)
        denom = 1 + z * z / n_eff
        center = (r + z * z / (2 * n_eff)) / denom
        half = z * math.sqrt(r * (1 - r) / n_eff + z * z / (4 * n_eff * n_eff)) / denom
        lo, hi = max(0.0, center - half), min(1.0, center + half)
    else:
        lo = hi = _nan()
    out.update({"estimate": r, "se": se, "ci_low": lo, "ci_high": hi, "n_effective": n_eff,
                "singleton_strata": [str(x) for x in singletons]})
    unidentified = [str(h) for h in singletons if stratum_sizes is None or stratum_sizes.get(h) != 1]
    if unidentified:
        out.update({"se": _nan(), "ci_low": _nan(), "ci_high": _nan(), "ci_estimable": False,
                    "not_estimable_reason": "variance unidentified in non-census singleton strata: " + ", ".join(unidentified)})
    return out


def weighted_proportion(y: Sequence[float], weights: Sequence[float],
                        strata: Optional[Sequence[Any]] = None,
                        stratum_sizes: Optional[Mapping[Any, float]] = None,
                        conf: float = DEFAULT_CONF) -> Dict[str, Any]:
    """Inverse-probability-weighted (Hajek) proportion of a 0/1 indicator."""
    y = np.asarray(y, dtype=float)
    out = weighted_ratio(y, np.ones_like(y), weights, strata, stratum_sizes, conf)
    out["statistic"] = "weighted_proportion"
    return out


def weighted_agreement(r1: Iterable[Any], r2: Iterable[Any], weights: Sequence[float],
                       strata: Optional[Sequence[Any]] = None,
                       stratum_sizes: Optional[Mapping[Any, float]] = None,
                       conf: float = DEFAULT_CONF) -> Dict[str, Any]:
    """Weighted observed agreement (or exact-match accuracy) over complete pairs."""
    a = _as_object_array(r1)
    b = _as_object_array(r2)
    w = np.asarray(list(weights), dtype=float)
    ok = (a.notna() & b.notna()).to_numpy()
    y = (a[ok].astype(str).to_numpy() == b[ok].astype(str).to_numpy()).astype(float)
    s = None if strata is None else np.asarray(list(strata), dtype=object)[ok]
    out = weighted_proportion(y, w[ok], s, stratum_sizes, conf)
    out["statistic"] = "weighted_agreement"
    out["n_pairs_excluded_missing"] = int((~ok).sum())
    return out


def weighted_diagnostic_accuracy(index: Iterable[Any], reference: Iterable[Any],
                                 weights: Sequence[float], positive: str, negative: str,
                                 strata: Optional[Sequence[Any]] = None,
                                 stratum_sizes: Optional[Mapping[Any, float]] = None,
                                 conf: float = DEFAULT_CONF) -> Dict[str, Any]:
    """IPW sensitivity, specificity, PPV and NPV over binary pairs (domain ratios).

    Each metric is a ratio of weighted counts. Non-binary pairs get zero in both
    numerator and denominator but stay in the variance calculation (domain
    estimation), so the design is respected.
    """
    i_all = _as_object_array(index).astype(object)
    r_all = _as_object_array(reference).astype(object)
    w = np.asarray(list(weights), dtype=float)
    s = _strata_array(strata, len(w))
    ix = np.array([str(x) if x is not None else "" for x in i_all])
    rf = np.array([str(x) if x is not None else "" for x in r_all])
    binary = np.isin(ix, [positive, negative]) & np.isin(rf, [positive, negative])
    ip = (ix == positive) & binary
    ineg = (ix == negative) & binary
    rp = (rf == positive) & binary
    rn = (rf == negative) & binary
    f = lambda num, den: weighted_ratio(num.astype(float), den.astype(float), w, s, stratum_sizes, conf)
    return {
        "positive_label": positive, "negative_label": negative,
        "n_binary_pairs": int(binary.sum()),
        "sensitivity": f(ip & rp, rp),
        "specificity": f(ineg & rn, rn),
        "ppv": f(ip & rp, ip),
        "npv": f(ineg & rn, ineg),
        "false_positive_rate": f(ip & rn, rn),
        "false_negative_rate": f(ineg & rp, rp),
    }


def trial_impact(changed: Sequence[Any], n_trials: Sequence[float],
                 weights: Optional[Sequence[float]] = None,
                 strata: Optional[Sequence[Any]] = None,
                 stratum_sizes: Optional[Mapping[Any, float]] = None,
                 conf: float = DEFAULT_CONF) -> Dict[str, Any]:
    """Frequency-weighted trial impact of revised decisions.

    changed: 1 if the adjudicated decision revises the original classification.
    n_trials: number of trials carrying the reviewed heading (or 1 for a
    trial-level case).

    Returns the in-sample total (exact, unweighted) and, when weights are
    given, the Horvitz-Thompson estimate of the frame total with a stratified
    with-replacement linearization SE (optional FPC). Units are heading-trial
    pairs: a trial carrying two revised headings counts twice. Unique affected
    trials must come from the deterministic pipeline, which applies approved
    decisions to every trial.
    """
    c = np.asarray([_truthy(x) for x in changed], dtype=float)
    t = np.asarray(n_trials, dtype=float)
    if len(c) != len(t):
        raise ValueError("changed and n_trials differ in length")
    if np.any(~np.isfinite(t)) or np.any(t < 0):
        raise ValueError("n_trials must be finite and non-negative")
    out: Dict[str, Any] = {
        "unit": "heading-trial pairs (a trial carrying several revised headings counts once per heading)",
        "n_cases": int(len(c)),
        "n_cases_changed": int(c.sum()),
        "in_sample_total": float((c * t).sum()),
    }
    if weights is None:
        return out
    w = np.asarray(weights, dtype=float)
    if len(w) != len(c):
        raise ValueError("weights length mismatch")
    u = w * c * t
    s = _strata_array(strata, len(u))
    var = 0.0
    singletons = []
    for h in pd.unique(s):
        mask = s == h
        n_h = int(mask.sum())
        if n_h < 2:
            singletons.append(str(h))
            continue
        fpc = 1.0
        if stratum_sizes is not None and h in stratum_sizes and stratum_sizes[h]:
            fpc = max(0.0, 1.0 - n_h / float(stratum_sizes[h]))
        uh = u[mask]
        var += fpc * n_h / (n_h - 1) * float(((uh - uh.mean()) ** 2).sum())
    total = float(u.sum())
    se = math.sqrt(var)
    z = _z(conf)
    out.update({
        "estimated_frame_total": total,
        "se": se,
        "ci_low": max(0.0, total - z * se),
        "ci_high": total + z * se,
        "ci_method": "normal approximation, Horvitz-Thompson total, stratified linearization",
        "singleton_strata": singletons,
        "conf_level": conf,
    })
    return out


# ---------------------------------------------------------------------------
# Grouped summaries for the dashboard
# ---------------------------------------------------------------------------

def stratified_agreement(df: pd.DataFrame, group_cols: Sequence[str], r1_col: str, r2_col: str,
                         conf: float = DEFAULT_CONF) -> pd.DataFrame:
    """Raw agreement by group (for example by layer and therapeutic area)."""
    rows = []
    for key, g in df.groupby(list(group_cols), dropna=False, sort=True):
        key = key if isinstance(key, tuple) else (key,)
        ra = raw_agreement(g[r1_col], g[r2_col], conf)
        rows.append({**dict(zip(group_cols, key)), "n_pairs": ra["n"], "n_agree": ra["x"],
                     "n_disagree": ra["n"] - ra["x"], "agreement": ra["estimate"],
                     "ci_low": ra["ci_low"], "ci_high": ra["ci_high"],
                     "n_pairs_excluded_missing": ra["n_pairs_excluded_missing"]})
    return pd.DataFrame(rows)


def sample_size_table(ps: Sequence[float] = (0.70, 0.75, 0.80, 0.85, 0.90),
                      ns: Sequence[int] = (100, 150, 200),
                      conf: float = DEFAULT_CONF) -> pd.DataFrame:
    """Wilson interval half-widths for planning (REVIEW_PROTOCOL.md table)."""
    rows = []
    for p in ps:
        for n in ns:
            lo, hi = wilson_ci(round(p * n), n, conf) if float(p * n).is_integer() else (_nan(), _nan())
            rows.append({"p": p, "n": n, "half_width": wilson_half_width(p, n, conf),
                         "ci_low_at_p": lo, "ci_high_at_p": hi})
    return pd.DataFrame(rows)
