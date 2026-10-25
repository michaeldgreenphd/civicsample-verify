"""Versioned engineering validation; no estimator or clinical-policy approval.

Bundle 8.1 adds a frozen probability artifact and per-revision subtype observations.
The main analyzer remains synthetic-only. Membership routing is not changed here.
"""
from __future__ import annotations
import hashlib
import re
from decimal import Decimal
import pandas as pd

SUBTYPES = {"TYPE_2_STATED", "TYPE_2_NOT_STATED", "CANNOT_TELL_FROM_PACKET"}
CODES = {"D4A_KEEP_UNRESOLVED_PARENT_ONLY", "D4B_KEEP_UNRESOLVED_COMPLICATION_ONLY"}


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def verify(path, man, units, design, judgments, require):
    require(man.get("vocabulary_version") == "mu81-subtype-1", "unknown subtype vocabulary")
    dv = man["design"]["design_version"]
    require(dv == "review-design-v8.1.0" or dv.startswith("SYN-8-1-"), "bundle 8.1 requires design v8.1")
    def read(name):
        require((path / name).is_file(), f"missing {name}")
        raw = (path / name).read_bytes()
        require(hashlib.sha256(raw).hexdigest() == man["files"].get(name), f"{name}: checksum mismatch")
        table = pd.read_csv(path / name, dtype=str, keep_default_na=False)
        require(len(table) == man["row_counts"].get(name), f"{name}: row count mismatch")
        return table, raw.decode("utf-8")
    obs, _ = read("subtype_observations.csv")
    require(set(obs.columns) == {"unit_id", "mode", "reviewer_slot", "revision_number", "answer", "diabetes_subtype", "content_sha256"}, "invalid subtype columns")
    require(obs["mode"].eq("FORMAL").all(), "subtype observations must be FORMAL")
    require(obs.revision_number.str.fullmatch(r"[1-9][0-9]*").all(), "invalid subtype revision")
    require(obs.reviewer_slot.isin(["1", "2"]).all(), "invalid subtype reviewer slot")
    require(obs.content_sha256.str.fullmatch(r"[0-9a-f]{64}").all(), "invalid judgment digest")
    require(not obs.duplicated(["unit_id", "reviewer_slot", "revision_number"]).any(), "duplicate subtype revision")
    require(obs.unit_id.isin(units.unit_id).all(), "unknown subtype unit")
    codes = dict(zip(units.unit_id, units.assignment_code))
    require(obs.answer.isin(["AGREE", "DISAGREE", "CANNOT_TELL"]).all(), "invalid subtype membership answer")
    needed = obs.unit_id.map(codes).isin(CODES)
    require(obs.loc[needed, "diabetes_subtype"].isin(SUBTYPES).all(), "missing or invalid required subtype")
    require(obs.loc[~needed, "diabetes_subtype"].eq("").all(), "subtype on an ineligible unit")
    obs = obs.assign(revision_number=obs.revision_number.astype(int)).sort_values(["unit_id", "reviewer_slot", "revision_number"])
    counts = []
    for j in judgments.itertuples():
        group = obs[(obs.unit_id == j.unit_id) & (obs.reviewer_slot == j.reviewer_slot)]
        n = int(j.n_revisions) + 1 if j.judgment_status == "ANSWERED" else 0
        require(list(group.revision_number) == list(range(1, n+1)), "subtype history does not match judgment revisions")
        if not n:
            continue
        for stage, row in [("initial", group.iloc[0]), ("effective", group.iloc[-1])]:
            require(row.answer == getattr(j, f"answer_{stage}"), "subtype membership endpoint mismatch")
            if codes[j.unit_id] in CODES:
                require(getattr(j, f"reason_{stage}") != "TYPE_2_STATED", "stated type cannot be a v8.1 disagreement reason")
                counts.append({"stage": stage, "reviewer_slot": j.reviewer_slot,
                               "membership_answer": row.answer, "diabetes_subtype": row.diabetes_subtype})
    summary = pd.DataFrame(counts, columns=["stage", "reviewer_slot", "membership_answer", "diabetes_subtype"])
    summary = summary.groupby(list(summary.columns), dropna=False).size().reset_index(name="count")
    # Counts do not collapse reviewer observations into a reference label.
    probabilities = None
    binding = man.get("probability_binding")
    freeze = man["freeze"]
    if man["design"]["overlap_setting"] == "ONE_PER_TRIAL":
        require(isinstance(binding, dict), "missing probability binding")
        p, csv = read("probabilities.csv")
        original, source = read("probability_source.csv")
        require(list(p.columns) == ["unit_id", "pi_i", "mc_standard_error"], "invalid probability columns")
        require(p.unit_id.is_unique and set(p.unit_id) == set(units.unit_id), "probability coverage mismatch")
        require(list(p.unit_id) == sorted(p.unit_id), "probabilities must be sorted")
        for col in ["pi_i", "mc_standard_error"]:
            require(p[col].str.fullmatch(r"(?:0|1|0\.[0-9]{0,29}[1-9])").all(), "noncanonical probability decimal")
        require(all(0 < Decimal(x) <= 1 for x in p.pi_i), "invalid inclusion probability")
        require(all(0 <= Decimal(x) <= 1 for x in p.mc_standard_error), "invalid Monte Carlo error")
        body = "".join(f"{u},{pi},{se}\n" for u, pi, se in p.itertuples(index=False, name=None))
        require(csv == "unit_id,pi_i,mc_standard_error\n" + body, "noncanonical probability CSV")
        require(binding.get("binding_version") == "mu81-probability-1" and binding.get("method") == "MONTE_CARLO_ONE_PER_TRIAL", "unknown probability method/version")
        require(type(binding.get("replicates")) is int and binding["replicates"] > 1, "invalid replicate count")
        require(type(binding.get("seed")) is int and 0 <= binding["seed"] < 10**15, "invalid probability seed")
        require(binding.get("design_version") == dv, "probability design mismatch")
        require(design.sampling_seed.eq(str(binding["seed"])).all(), "probability seed mismatch")
        require(binding.get("file_sha256") == sha(source) and binding.get("rows_sha256") == sha(body), "probability digest mismatch")
        require(list(original.columns) == ["unit_id", "stratum", "N_h", "n_h", "nominal_probability_n_h_over_N_h", "pi_mc_ONE_PER_TRIAL", "mc_se", "pattern_group_units", "weight_ONE_PER_TRIAL", "ratio_mc_to_nominal"], "invalid original probability columns")
        require(original.unit_id.is_unique and set(original.unit_id) == set(p.unit_id), "original probability inventory mismatch")
        original = original.set_index("unit_id")
        for row in p.itertuples():
            src = original.loc[row.unit_id]
            try:
                equal = Decimal(src.pi_mc_ONE_PER_TRIAL) == Decimal(row.pi_i) and Decimal(src.mc_se) == Decimal(row.mc_standard_error)
                nominal = abs(float(src.nominal_probability_n_h_over_N_h) - float(design.loc[row.unit_id, "selection_probability"])) < 1e-12
            except (ArithmeticError, ValueError):
                equal, nominal = False, False
            require(equal, "original probability values differ from canonical binding")
            require(nominal and src.stratum == design.loc[row.unit_id, "stratum"]
                    and src.N_h == design.loc[row.unit_id, "frame_stratum_size"]
                    and src.n_h == design.loc[row.unit_id, "n_sampled_in_stratum"], "original probability design mismatch")
        digest = sha("|".join(str(binding[k]) for k in ["binding_version", "design_version", "method", "replicates", "seed", "file_sha256", "rows_sha256"]))
        require(binding.get("binding_sha256") == digest == freeze.get("probability_binding_sha256"), "probability binding differs from freeze")
        probabilities = p
    else:
        require(binding is None and freeze.get("probability_binding_sha256") is None and "probabilities.csv" not in man["files"] and "probability_source.csv" not in man["files"], "ALLOW must retain nominal probabilities")
    return probabilities, summary
