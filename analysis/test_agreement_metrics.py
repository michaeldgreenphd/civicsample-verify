"""SYNTHETIC ENGINEERING ONLY. Proposed analysis; no clinical study results."""

from __future__ import annotations

import math

import numpy as np
import pandas as pd
import pytest

from analysis import agreement_metrics as am
from analysis import review_codes as rc

L1 = rc.layer_codes("clinical_classification")


def expand(table, cats):
    """Turn a square count table into two label lists."""
    r1, r2 = [], []
    for i, a in enumerate(cats):
        for j, b in enumerate(cats):
            r1 += [a] * table[i][j]
            r2 += [b] * table[i][j]
    return r1, r2


# --- Wilson interval --------------------------------------------------------

def test_wilson_known_values():
    lo, hi = am.wilson_ci(50, 100)
    assert lo == pytest.approx(0.4038, abs=1e-4) and hi == pytest.approx(0.5962, abs=1e-4)
    lo, hi = am.wilson_ci(0, 10)
    assert lo == 0.0 and hi == pytest.approx(0.2775, abs=1e-4)
    lo, hi = am.wilson_ci(10, 10)
    assert lo == pytest.approx(0.7225, abs=1e-4) and hi == 1.0


def test_wilson_zero_n_is_nan():
    lo, hi = am.wilson_ci(0, 0)
    assert math.isnan(lo) and math.isnan(hi)


def test_sample_size_table_matches_protocol():
    t = am.sample_size_table()
    get = lambda p, n: float(t[(t.p == p) & (t.n == n)].half_width.iloc[0])
    assert get(0.70, 100) == pytest.approx(0.0884, abs=1e-4)
    assert get(0.80, 100) == pytest.approx(0.0777, abs=1e-4)
    assert get(0.90, 200) == pytest.approx(0.0419, abs=1e-4)


# --- Raw agreement and kappa ------------------------------------------------

def test_raw_agreement_counts_excluded_missing():
    r1 = ["INCLUDE", "EXCLUDE", None, "INCLUDE"]
    r2 = ["INCLUDE", "INCLUDE", "INCLUDE", ""]
    out = am.raw_agreement(r1, r2)
    assert out["n"] == 2 and out["x"] == 1 and out["n_pairs_excluded_missing"] == 2


def test_kappa_textbook_2x2():
    # po = 35/50 = 0.70; row margins .5/.5; column margins .6/.4; pe = .5; kappa = .40
    r1, r2 = expand([[20, 5], [10, 15]], ["INCLUDE", "EXCLUDE"])
    k = am.cohen_kappa(r1, r2, ["INCLUDE", "EXCLUDE"])
    assert k["po"] == pytest.approx(0.70)
    assert k["pe"] == pytest.approx(0.50)
    assert k["kappa"] == pytest.approx(0.40)
    assert k["estimable"] and k["ci_low"] < 0.40 < k["ci_high"]


def test_kappa_perfect_agreement():
    r = ["INCLUDE"] * 10 + ["EXCLUDE"] * 10 + ["CONTEXT_DEPENDENT"] * 6
    k = am.cohen_kappa(r, r, L1)
    assert k["kappa"] == pytest.approx(1.0)


def test_kappa_undefined_when_single_category():
    r = ["INCLUDE"] * 20
    k = am.cohen_kappa(r, r, L1)
    assert not k["estimable"] and math.isnan(k["kappa"])
    assert not k["kappa_primary_recommended"]
    assert k["secondary_reasons"]


def test_kappa_rule_flags_prevalence_effect():
    # 95 of 100 agree on INCLUDE: high pe, kappa not primary
    r1, r2 = expand([[93, 2], [3, 2]], ["INCLUDE", "EXCLUDE"])
    k = am.cohen_kappa(r1, r2, ["INCLUDE", "EXCLUDE"])
    assert k["pe"] > am.MAX_PE_FOR_PRIMARY
    assert not k["kappa_primary_recommended"]


def test_unknown_label_raises_not_dropped():
    with pytest.raises(ValueError):
        am.cohen_kappa(["INCLUDE", "MAYBE"], ["INCLUDE", "EXCLUDE"], L1)


def test_kappa_se_matches_statsmodels_if_available():
    sm = pytest.importorskip("statsmodels.stats.inter_rater")
    table = np.array([[30, 4, 2], [5, 25, 3], [1, 2, 28]])
    cats = ["INCLUDE", "EXCLUDE", "CONTEXT_DEPENDENT"]
    r1, r2 = expand(table.tolist(), cats)
    k = am.cohen_kappa(r1, r2, cats)
    ref = sm.cohens_kappa(table)
    assert k["kappa"] == pytest.approx(ref.kappa, abs=1e-10)
    assert k["se"] == pytest.approx(ref.std_kappa, abs=1e-10)


def test_kappa_analytic_se_close_to_bootstrap_se():
    rng = np.random.default_rng(7)
    truth = rng.choice(["INCLUDE", "EXCLUDE", "CONTEXT_DEPENDENT"], size=1500, p=[0.5, 0.35, 0.15])
    noisy = lambda: [t if rng.random() < 0.85 else rng.choice(L1[:3]) for t in truth]
    r1, r2 = noisy(), noisy()
    k = am.cohen_kappa(r1, r2, L1)
    a = np.array(r1)
    b = np.array(r2)
    boot = []
    rng2 = np.random.default_rng(11)
    for _ in range(400):
        idx = rng2.integers(0, len(a), len(a))
        boot.append(am.cohen_kappa(a[idx], b[idx], L1)["kappa"])
    assert np.std(boot, ddof=1) == pytest.approx(k["se"], rel=0.15)


def test_kappa_bootstrap_reproducible_and_brackets_estimate():
    r1, r2 = expand([[40, 6, 2, 1], [5, 30, 3, 0], [2, 2, 6, 1], [0, 1, 0, 1]], L1)
    a = am.kappa_bootstrap_ci(r1, r2, L1, reps=500, seed=99)
    b = am.kappa_bootstrap_ci(r1, r2, L1, reps=500, seed=99)
    k = am.cohen_kappa(r1, r2, L1)["kappa"]
    assert a["ci_low"] == b["ci_low"] and a["ci_high"] == b["ci_high"]
    assert a["ci_low"] < k < a["ci_high"]


def test_stratified_bootstrap_runs():
    r1, r2 = expand([[40, 6], [5, 49]], ["INCLUDE", "EXCLUDE"])
    strata = ["A"] * 50 + ["B"] * 50
    out = am.kappa_bootstrap_ci(r1, r2, ["INCLUDE", "EXCLUDE"], reps=200, seed=1, strata=strata)
    assert out["stratified"] and out["ci_low"] < out["ci_high"]


# --- PABAK and AC1 ------------------------------------------------------------

def test_pabak_binary_and_four_category():
    r1, r2 = expand([[45, 5], [5, 45]], ["INCLUDE", "EXCLUDE"])
    assert am.pabak(r1, r2, ["INCLUDE", "EXCLUDE"])["pabak"] == pytest.approx(0.80)
    # with the four-option scale, k = 4: (4 * 0.9 - 1) / 3
    assert am.pabak(r1, r2, L1)["pabak"] == pytest.approx((4 * 0.9 - 1) / 3)


def test_gwet_ac1_hand_computed():
    # po = .9; pi = (.45, .55); pe = .45*.55 + .55*.45 = .495; AC1 = (.9 - .495) / .505
    r1, r2 = expand([[40, 5], [5, 50]], ["INCLUDE", "EXCLUDE"])
    out = am.gwet_ac1(r1, r2, ["INCLUDE", "EXCLUDE"])
    assert out["ac1"] == pytest.approx((0.9 - 0.495) / 0.505)


def test_agreement_summary_has_all_parts():
    r1, r2 = expand([[30, 3, 1, 0], [4, 25, 2, 1], [1, 2, 8, 1], [0, 0, 1, 2]], L1)
    s = am.agreement_summary(r1, r2, L1, reps=200, seed=3)
    assert {"raw_agreement", "kappa", "kappa_bootstrap", "pabak", "ac1", "ac1_bootstrap",
            "primary_statistic"} <= set(s)


# --- Accuracy against a reference ------------------------------------------------

def test_diagnostic_accuracy_counts_and_exclusions():
    index = ["INCLUDE"] * 40 + ["EXCLUDE"] * 10 + ["EXCLUDE"] * 45 + ["INCLUDE"] * 5 + ["INCLUDE"] * 3
    ref = ["INCLUDE"] * 40 + ["INCLUDE"] * 10 + ["EXCLUDE"] * 45 + ["EXCLUDE"] * 5 + ["CONTEXT_DEPENDENT"] * 3
    d = am.diagnostic_accuracy(index, ref, "INCLUDE", "EXCLUDE")
    assert (d["tp"], d["fn"], d["tn"], d["fp"]) == (40, 10, 45, 5)
    assert d["sensitivity"]["estimate"] == pytest.approx(0.8)
    assert d["specificity"]["estimate"] == pytest.approx(0.9)
    assert d["ppv"]["estimate"] == pytest.approx(40 / 45)
    assert d["npv"]["estimate"] == pytest.approx(45 / 55)
    assert d["false_positive_rate"]["estimate"] == pytest.approx(0.1)
    assert d["false_negative_rate"]["estimate"] == pytest.approx(0.2)
    assert d["excluded"]["nonbinary_reference"] == 3


# --- Weighted estimation -----------------------------------------------------------

def test_weighted_proportion_equal_weights_matches_simple():
    y = [1] * 30 + [0] * 70
    out = am.weighted_proportion(y, [2.0] * 100)
    assert out["estimate"] == pytest.approx(0.30)
    assert out["se"] == pytest.approx(math.sqrt(0.3 * 0.7 / 99))


def test_ipw_recovers_population_rate():
    # Stratum A: N = 900, 30 sampled, 27 positive (0.9). Stratum B: N = 100, 30 sampled, 15 positive (0.5).
    y = [1] * 27 + [0] * 3 + [1] * 15 + [0] * 15
    w = [900 / 30] * 30 + [100 / 30] * 30
    s = ["A"] * 30 + ["B"] * 30
    out = am.weighted_proportion(y, w, s)
    assert out["estimate"] == pytest.approx((900 * 0.9 + 100 * 0.5) / 1000)
    assert np.mean(y) == pytest.approx(0.70)  # unweighted would be biased


def test_fpc_reduces_variance():
    y = [1] * 27 + [0] * 3 + [1] * 15 + [0] * 15
    w = [900 / 30] * 30 + [100 / 30] * 30
    s = ["A"] * 30 + ["B"] * 30
    no_fpc = am.weighted_proportion(y, w, s)
    fpc = am.weighted_proportion(y, w, s, stratum_sizes={"A": 900, "B": 100})
    assert fpc["se"] < no_fpc["se"]


def test_weighted_diagnostic_accuracy_equal_weights_matches_unweighted():
    index = ["INCLUDE"] * 40 + ["EXCLUDE"] * 10 + ["EXCLUDE"] * 45 + ["INCLUDE"] * 5
    ref = ["INCLUDE"] * 50 + ["EXCLUDE"] * 50
    wd = am.weighted_diagnostic_accuracy(index, ref, [1.0] * 100, "INCLUDE", "EXCLUDE")
    assert wd["sensitivity"]["estimate"] == pytest.approx(0.8)
    assert wd["specificity"]["estimate"] == pytest.approx(0.9)


def test_weights_must_be_positive():
    with pytest.raises(ValueError):
        am.weighted_proportion([1, 0], [1.0, 0.0])


def test_trial_impact_totals():
    changed = [True, False, True, "1", 0]
    n_trials = [100, 50, 10, 5, 7]
    w = [2.0, 2.0, 4.0, 4.0, 4.0]
    s = ["A", "A", "B", "B", "B"]
    out = am.trial_impact(changed, n_trials, w, s)
    assert out["in_sample_total"] == 115
    assert out["n_cases_changed"] == 3
    assert out["estimated_frame_total"] == pytest.approx(2 * 100 + 4 * 10 + 4 * 5)
    assert out["se"] > 0


def test_stratified_agreement_table():
    df = pd.DataFrame({"area": ["ONC"] * 4 + ["CV"] * 4,
                       "a": ["INCLUDE", "INCLUDE", "EXCLUDE", "EXCLUDE"] * 2,
                       "b": ["INCLUDE", "EXCLUDE", "EXCLUDE", "EXCLUDE"] * 2})
    t = am.stratified_agreement(df, ["area"], "a", "b")
    assert set(t.area) == {"ONC", "CV"} and (t.n_pairs == 4).all() and (t.n_agree == 3).all()
