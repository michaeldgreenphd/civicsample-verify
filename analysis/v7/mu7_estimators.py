"""
validation/mu7_estimators.py  (review design v7: mapping-unit confirmation)

Estimators shared by validation/performance_analysis_v7.py and by the planning projections of the design folder, so
that the projected precision and the analysis use the same arithmetic.

Design: stratified simple random sampling without replacement of mapping units, one stratum per category (21 strata in
three families: AREA, ROW, SG), n_h units drawn from N_h, inclusion probability n_h / N_h, weight N_h / n_h.

Estimand of a family (or of one category): clinician confirmation of displayed assignments, the share of OUR ASSIGNED
mappings in the frame that the clinical reference confirms (reference answer AGREE), among units whose reference is
determinate (AGREE or DISAGREE). Reviewers see our assignment before they answer, so this is a confirmation share, not a
positive predictive value and not an accuracy, and it is not a proven upper bound of either (investigator decisions of
addendum 6). It says nothing about missed categories, because the review shows assigned mappings only.

Point estimate: the Hajek (combined ratio) estimator  theta = sum(w d y) / sum(w d),  where w = N_h / r_h (r_h = units
of stratum h with a reference, which equals n_h when every unit was reviewed), d = 1 for a determinate reference and
y = 1 for AGREE.
Variance: Taylor linearization of the ratio for stratified SRSWOR with the finite population correction:
  u_i = w_i d_i (y_i - theta) / sum(w d);  V = sum_h (1 - r_h / N_h) r_h / (r_h - 1) sum_{i in h} (u_i - mean_h(u))^2.
A stratum with a single reviewed unit gives no variance estimate; the domain is then flagged and no interval is given.
Interval: the Wilson 95% interval at an effective sample size n_eff, the SMALLER of (a) the variance-based effective
sample size theta (1 - theta) / V (the effective-n approach of Korn and Graubard 1998) and (b) Kish's effective sample
size of the weights of the determinate units, (sum w)^2 / sum w^2, truncated at the number of determinate units. Reason
(design v7, chosen before any review data exist): with 4 to 8 units per stratum the within-stratum variance is often
estimated as 0 (every unit of a stratum agrees), so (a) alone overstates precision; the planning simulation of
scripts/02_allocation_projection_v7.py (tables/coverage_simulation_v7.csv) compares the coverage of (a) alone with the
coverage of this rule. When V = 0 or theta is 0 or 1, (b) is used.
Not estimable: a domain with fewer than 10 determinate units (prespecified in v3) reports counts only.

Everything here is plain Python plus pandas and numpy; nothing reads or writes files.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

Z95 = 1.959963984540054
NOT_ESTIMABLE_BELOW = 10


def wilson(p: float, n: float, z: float = Z95) -> tuple[float, float]:
    """Wilson score interval for a proportion p observed on an (effective) sample of size n > 0."""
    if n <= 0 or p is None or (isinstance(p, float) and math.isnan(p)):
        return (float("nan"), float("nan"))
    den = 1.0 + z * z / n
    centre = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return (max(0.0, centre - half), min(1.0, centre + half))


def wilson_half_width(p: float, n: float, z: float = Z95) -> float:
    lo, hi = wilson(p, n, z)
    return (hi - lo) / 2.0


def kish_neff(w) -> float:
    w = np.asarray(w, dtype=float)
    if w.size == 0 or not np.isfinite(w).all() or (w <= 0).any():
        return float("nan")
    return float(w.sum() ** 2 / (w * w).sum())


def stratified_ratio(df: pd.DataFrame, domain_col: str = "in_domain", y_col: str = "y", d_col: str = "d",
                     stratum_col: str = "stratum", N_col: str = "N_h", reviewed_col: str = "reviewed",
                     weight_col: str | None = None, fpc: bool = True, cluster_col: str | None = None) -> dict:
    """Hajek ratio estimate of the confirmation share of a domain, with stratified linearization variance and a Wilson
    interval at the effective sample size.

    df: one row per SAMPLED unit of the whole design (every stratum), with the stratum, N_h, reviewed (bool: the unit has
    a reference), in_domain (bool: the unit belongs to the family or category being estimated), d (1 determinate
    reference, 0 not) and y (1 AGREE, 0 otherwise; ignored when d = 0). Units outside the domain enter the variance
    with u = 0, which is the standard domain estimator; when the domain is a union of whole strata (Option A) they add
    nothing. Returns counts, the estimate, the variance, n_eff, the interval and a status.

    weight_col: when given, the weights come from that column (for example 1 / pi from the Monte Carlo inclusion
    probabilities of the ONE_PER_TRIAL setting) instead of N_h / r_h; fpc=False then drops the finite population
    correction (the with-replacement approximation within strata). cluster_col: when given and some cluster (trial)
    holds two or more determinate units of the domain, the variance is the larger of the stratified variance and the
    cluster-robust variance n_c / (n_c - 1) sum_c (sum_{i in c} u_i)^2 over the n_c clusters, and n_eff is capped at
    n_c (investigator gate G-EST-01; PROPOSED).
    """
    x = df[df[reviewed_col].astype(bool)].copy()
    dom = x[domain_col].astype(bool)
    dd = (x[d_col].astype(float) * dom.astype(float))
    out = {"n_units": int(df[domain_col].astype(bool).sum()), "n_reviewed": int(dom.sum()),
           "n_determinate": int(dd.sum()), "n_confirmed": int((dd * x[y_col].astype(float)).sum())}
    out["n_not_confirmed"] = out["n_determinate"] - out["n_confirmed"]
    if out["n_determinate"] < NOT_ESTIMABLE_BELOW:
        out.update({"estimate": None, "variance": None, "n_eff": None, "ci_low": None, "ci_high": None,
                    "status": f"NOT_ESTIMABLE_FEWER_THAN_{NOT_ESTIMABLE_BELOW}_DETERMINATE_UNITS"})
        return out
    r_h = x.groupby(stratum_col)[stratum_col].transform("size").astype(float)
    w = x[weight_col].astype(float) if weight_col else x[N_col].astype(float) / r_h
    wd = w * dd
    theta = float((wd * x[y_col].astype(float)).sum() / wd.sum())
    x["u"] = wd * (x[y_col].astype(float) - theta) / wd.sum()
    x["_dd"] = dd
    V = 0.0
    singleton = False
    for _, g in x.groupby(stratum_col):
        r = len(g)
        Nh = float(g[N_col].iloc[0])
        if r < 2:
            if (g["_dd"] > 0).any():
                singleton = True
            continue
        V += ((1.0 - r / Nh) if fpc else 1.0) * r / (r - 1.0) * float(((g["u"] - g["u"].mean()) ** 2).sum())
    if singleton:
        out.update({"estimate": theta, "variance": None, "n_eff": None, "ci_low": None, "ci_high": None,
                    "status": "NO_INTERVAL_STRATUM_WITH_ONE_REVIEWED_UNIT"})
        return out
    n_det = out["n_determinate"]
    n_clusters = None
    variance_basis = "STRATIFIED"
    if cluster_col:
        det = x[x["_dd"] > 0]
        sizes = det.groupby(cluster_col).size()
        if (sizes >= 2).any():
            n_clusters = int(len(sizes))
            uc = x.groupby(cluster_col)["u"].sum()
            uc = uc[uc.index.isin(sizes.index)]
            V_cl = n_clusters / (n_clusters - 1.0) * float(((uc - uc.mean()) ** 2).sum()) if n_clusters > 1 else 0.0
            if V_cl > V:
                V = V_cl
                variance_basis = "CLUSTER_ROBUST_BY_TRIAL"
            else:
                variance_basis = "STRATIFIED_NOT_BELOW_CLUSTER"
    n_kish = kish_neff(w[dd > 0])
    n_var = theta * (1 - theta) / V if (V > 0 and 0.0 < theta < 1.0) else float("inf")
    n_eff = min(float(n_det), n_kish, n_var, float(n_clusters) if n_clusters else float("inf"))
    lo, hi = wilson(theta, n_eff)
    out.update({"estimate": theta, "variance": V, "n_eff": n_eff, "n_eff_kish": n_kish,
                "n_eff_variance": (None if n_var == float("inf") else n_var), "ci_low": lo, "ci_high": hi,
                "variance_basis": variance_basis, "n_trial_clusters": n_clusters, "status": "ESTIMATED"})
    return out


def projected_family(strata: pd.DataFrame, p_col: str = "prior", n_col: str = "n_h", N_col: str = "N_h") -> dict:
    """Planning projection (never an estimate) of the 95% half-width of a family's pooled confirmation share under
    planning priors p_h, every unit reviewed and determinate: theta = sum W_h p_h with W_h = N_h / N;
    V = sum W_h^2 (1 - n_h/N_h) S_h^2 / n_h with S_h^2 = p_h (1 - p_h) N_h / (N_h - 1); Wilson at n_eff = min(n, Kish n_eff, theta(1-theta)/V),
    the rule of stratified_ratio. Strata with n_h = 0 contribute no units (the estimate then misses those categories)."""
    s = strata[strata[n_col] > 0]
    N = float(s[N_col].sum())
    W = s[N_col].astype(float) / N
    p = s[p_col].astype(float)
    n = s[n_col].astype(float)
    Nh = s[N_col].astype(float)
    theta = float((W * p).sum())
    S2 = p * (1 - p) * Nh / (Nh - 1)
    V = float((W * W * (1 - n / Nh) * S2 / n).sum())
    n_tot = float(n.sum())
    kish = float(N ** 2 / (Nh * Nh / n).sum())
    n_var = theta * (1 - theta) / V if V > 0 else float("inf")
    n_eff = min(n_tot, kish, n_var)
    return {"theta_prior": theta, "variance": V, "n_eff": n_eff, "n_units": n_tot,
            "half_width": wilson_half_width(theta, n_eff), "kish_neff": kish,
            "estimable": n_tot >= NOT_ESTIMABLE_BELOW}


def projected_srs_domain(theta: float, n_dom: float, N_dom: float, N_total: float, n_total: float) -> dict:
    """Planning projection for a family under Option C (one simple random sample of n_total units from all N_total
    assigned units): the family is a domain of expected size n_dom; V = (1 - n_total/N_total) theta (1 - theta) / n_dom
    (no stratification gain); Wilson at n_dom."""
    V = (1 - n_total / N_total) * theta * (1 - theta) / n_dom if n_dom > 0 else float("nan")
    return {"theta_prior": theta, "variance": V, "n_eff": n_dom, "n_units": n_dom,
            "half_width": wilson_half_width(theta, n_dom) if n_dom > 0 else float("nan"),
            "kish_neff": n_dom, "estimable": n_dom >= NOT_ESTIMABLE_BELOW}


def cohen_kappa(a: list, b: list, categories: list) -> dict:
    """Cohen's kappa for two raters on the same units (nominal categories), with percent agreement."""
    a = list(a); b = list(b)
    n = len(a)
    if n == 0:
        return {"n": 0, "po": None, "pe": None, "kappa": None}
    po = sum(1 for x, y in zip(a, b) if x == y) / n
    pe = sum((a.count(c) / n) * (b.count(c) / n) for c in categories)
    kappa = (po - pe) / (1 - pe) if pe < 1 else None
    return {"n": n, "po": po, "pe": pe, "kappa": kappa}


def kappa_bootstrap_ci(a: list, b: list, categories: list, reps: int = 2000, seed: int = 2026102307) -> tuple:
    """Percentile bootstrap 95% interval for Cohen's kappa, resampling units; reps and seed recorded in the output."""
    rng = np.random.default_rng(seed)
    a = np.asarray(a, dtype=object); b = np.asarray(b, dtype=object)
    n = len(a)
    ks = []
    for _ in range(reps):
        idx = rng.integers(0, n, n)
        k = cohen_kappa(list(a[idx]), list(b[idx]), categories)["kappa"]
        if k is not None:
            ks.append(k)
    if not ks:
        return (None, None)
    return (float(np.percentile(ks, 2.5)), float(np.percentile(ks, 97.5)))
