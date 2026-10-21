"""Synthetic adversarial regressions for export provenance and analysis semantics."""

import copy
import hashlib
import json
from pathlib import Path

import pandas as pd
import pytest

from analysis import performance_analysis_v3 as pa3
from analysis import performance_analysis_v4 as pa4
from analysis.fixtures import make_synthetic_v4_bundle as fx


@pytest.fixture
def bundle():
    data, manifest = pa4.load_bundle(str(Path(__file__).parent / "fixtures" / fx.MANIFEST_NAME))
    return {name: frame.copy() for name, frame in data.items()}, copy.deepcopy(manifest)


def validate(bundle, **kwargs):
    return pa4.validate_bundle(*bundle, allow_synthetic=True, **kwargs)


def results(bundle):
    merged, checks = validate(bundle)
    return pa4.build_results(merged, bundle[1], checks)


def rehashed_bundle(tmp_path, role, column, value):
    """Change a real CSV and honestly rehash it, so validation must inspect its meaning."""
    manifest = fx.write(tmp_path)
    csv = tmp_path / fx.FILE_NAMES[role]
    frame = pd.read_csv(csv, dtype=str, keep_default_na=False)
    frame.loc[0, column] = value
    frame.to_csv(csv, index=False, lineterminator="\n")
    digest = hashlib.sha256(csv.read_bytes()).hexdigest()
    for entry in manifest["files"]:
        if entry["role"] == role:
            entry["sha256"] = digest
    if role == "frozen_predictions":
        manifest["frozen_prediction_set_sha256"] = digest
    path = tmp_path / fx.MANIFEST_NAME
    path.write_text(json.dumps(manifest), encoding="utf-8")
    return pa4.load_bundle(str(path))


@pytest.mark.parametrize("role", ["independent_judgments", "adjudicated_reference"])
@pytest.mark.parametrize("export_id", ["FX-OTHER-EXPORT", "", None])
def test_rehashed_csv_cannot_mix_export_ids(tmp_path, role, export_id):
    changed = rehashed_bundle(tmp_path, role, "export_id", export_id)
    with pytest.raises(pa4.ExportError, match="export_id must match"):
        validate(changed)


@pytest.mark.parametrize("export_id", ["", "  ", None])
def test_manifest_export_id_cannot_be_missing(bundle, export_id):
    bundle[1]["export_id"] = export_id
    with pytest.raises(pa4.ExportError, match="export_id must be nonblank"):
        validate(bundle)


@pytest.mark.parametrize("module", ["BENCHMARK_COMPATIBILITY", "", None])
def test_rehashed_csv_cannot_mix_review_modules(tmp_path, module):
    changed = rehashed_bundle(tmp_path, "independent_judgments", "review_module", module)
    with pytest.raises(pa4.ExportError, match="review_module must match"):
        validate(changed)


@pytest.mark.parametrize("prediction_set", ["FX-OTHER-PREDICTIONS", "", "  ", None])
def test_rehashed_predictions_cannot_mix_or_omit_set_identity(tmp_path, prediction_set):
    changed = rehashed_bundle(tmp_path, "frozen_predictions", "prediction_set_id", prediction_set)
    with pytest.raises(pa4.ExportError, match="one nonblank prediction_set_id"):
        validate(changed)


@pytest.mark.parametrize("column", ["adjudication_blinded", "adjudicator_exposed_to_index_labels",
                                    "post_unblinding_revision_exists"])
@pytest.mark.parametrize("missing", ["", None])
@pytest.mark.parametrize("allow_exposed", [False, True])
def test_unknown_blinding_provenance_is_never_treated_as_false(bundle, column, missing, allow_exposed):
    bundle[0]["adjudicated_reference"].loc[0, column] = missing
    with pytest.raises(pa4.ExportError, match=f"{column} must be an explicit boolean"):
        validate(bundle, allow_exposed_reference=allow_exposed)


@pytest.mark.parametrize("uncertain", ["", None, "unknown"])
def test_every_submitted_judgment_requires_explicit_uncertainty(bundle, uncertain):
    bundle[0]["independent_judgments"].loc[0, "uncertain"] = uncertain
    with pytest.raises(pa3.ExportError, match="boolean"):
        validate(bundle)


def test_valid_boolean_values_and_exposure_counts_are_preserved(bundle):
    J, A = bundle[0]["independent_judgments"], bundle[0]["adjudicated_reference"]
    J["uncertain"] = "false"
    J.loc[0, "uncertain"] = "true"
    result = results(bundle)
    assert sum(group["either_uncertain"] for group in result["uncertainty"].values()) == 1
    assert result["blinding"]["n_adjudicator_exposed_to_index_labels"] == 0
    A.loc[0, "adjudicator_exposed_to_index_labels"] = "true"
    with pytest.raises(pa4.ExportError, match="exposed"):
        validate(bundle)
    merged, checks = validate(bundle, allow_exposed_reference=True)
    exposed = pa4.build_results(merged, bundle[1], checks)
    assert exposed["blinding"]["n_adjudicator_exposed_to_index_labels"] == 1


def all_case_adjudication(bundle):
    A = bundle[0]["adjudicated_reference"]
    rule = A.adjudication_status == "CONCORDANT_ADOPTED_BY_RULE"
    A.loc[rule, ["adjudication_status", "adjudicator_pseudo_id", "adjudicator_role"]] = [
        "CONCORDANT_CONFIRMED", fx.ADJUDICATOR, "ADJUDICATOR"]
    bundle[1]["adjudication_scope"] = "ALL_CASE_LEVELS"
    return A, A.index[rule][0]


@pytest.mark.parametrize("status,change_reference", [("CONCORDANT_CONFIRMED", True), ("CONCORDANT_REVISED", False)])
def test_concordant_status_must_describe_the_reference(bundle, status, change_reference):
    A, row = all_case_adjudication(bundle)
    A.loc[row, "adjudication_status"] = status
    if change_reference:
        A.loc[row, "adjudicated_decision"] = "EXCLUDE" if A.loc[row, "adjudicated_decision"] == "INCLUDE" else "INCLUDE"
        A.loc[row, "adjudication_basis"] = "NEITHER"
    with pytest.raises(pa4.ExportError, match=status):
        validate(bundle)


@pytest.mark.parametrize("status", ["CONCORDANT_CONFIRMED", "CONCORDANT_REVISED"])
def test_valid_concordant_statuses_preserve_their_distinct_meaning(bundle, status):
    A, row = all_case_adjudication(bundle)
    A.loc[row, "adjudication_status"] = status
    if status == "CONCORDANT_REVISED":
        A.loc[row, "adjudicated_decision"] = "EXCLUDE" if A.loc[row, "adjudicated_decision"] == "INCLUDE" else "INCLUDE"
        A.loc[row, "adjudication_basis"] = "NEITHER"
    merged, _ = validate(bundle)
    assert merged.loc[merged.case_id == A.loc[row, "case_id"], "adjudication_status"].iloc[0] == status


@pytest.mark.parametrize("unresolved,basis", [(True, "REVIEWER_1"), (True, "BOTH_REVIEWERS"),
                                             (True, "NEITHER"), (False, "NONE")])
def test_basis_none_exactly_matches_unresolved_disposition(bundle, unresolved, basis):
    A = bundle[0]["adjudicated_reference"]
    row = A.index[(A.adjudication_status == "UNRESOLVED_ESCALATED") == unresolved][0]
    A.loc[row, "adjudication_basis"] = basis
    with pytest.raises(pa4.ExportError, match="NONE exactly when"):
        validate(bundle)


def discordant_case(bundle):
    J, A = bundle[0]["independent_judgments"], bundle[0]["adjudicated_reference"]
    row = A.index[A.adjudication_status == "DISCORDANT_RESOLVED"][0]
    key = (J.case_id == A.loc[row, "case_id"]) & (J.determination_level == A.loc[row, "determination_level"])
    answers = J.loc[key].set_index("reviewer_slot").decision_effective_preclose.to_dict()
    return A, row, key, answers


@pytest.mark.parametrize("basis", ["REVIEWER_1", "REVIEWER_2", "BOTH_REVIEWERS", "NEITHER"])
def test_basis_cannot_claim_an_incompatible_reviewer_decision(bundle, basis):
    A, row, _, answers = discordant_case(bundle)
    A.loc[row, "adjudication_basis"] = basis
    A.loc[row, "adjudicated_decision"] = answers["2"] if basis == "REVIEWER_1" else answers["1"]
    with pytest.raises(pa4.ExportError, match=f"adjudication_basis {basis}"):
        validate(bundle)


@pytest.mark.parametrize("basis", ["REVIEWER_1", "REVIEWER_2", "NEITHER"])
def test_valid_discordant_basis_adopts_the_declared_decision(bundle, basis):
    A, row, _, answers = discordant_case(bundle)
    decision = next(code for code in pa4.L1_CODES if code not in answers.values()) if basis == "NEITHER" else answers[basis[-1]]
    A.loc[row, ["adjudication_basis", "adjudicated_decision"]] = [basis, decision]
    validate(bundle)


@pytest.mark.parametrize("basis", ["REVIEWER_2", "BOTH_REVIEWERS"])
def test_basis_cannot_attribute_a_missing_reviewers_answer(bundle, basis):
    A, row, key, answers = discordant_case(bundle)
    J = bundle[0]["independent_judgments"]
    bundle[0]["independent_judgments"] = J[~(key & (J.reviewer_slot == "2"))].copy()
    A.loc[row, ["adjudication_status", "adjudication_basis", "adjudicated_decision"]] = [
        "SINGLE_REVIEW_ADJUDICATED", basis, answers["1"]]
    with pytest.raises(pa4.ExportError, match=f"adjudication_basis {basis}"):
        validate(bundle)


@pytest.mark.parametrize("slot", ["1", "2"])
def test_revision_count_includes_amendments_that_retain_the_decision(bundle, slot):
    baseline = results(bundle)
    J = bundle[0]["independent_judgments"]
    revisions = J.assign(revised=pd.to_numeric(J.n_revisions_preclose) > 0).groupby(["case_id", "determination_level"]).revised.any()
    case, level = revisions[~revisions].index[0]
    row = J.index[(J.case_id == case) & (J.determination_level == level) & (J.reviewer_slot == slot)][0]
    assert J.loc[row, "decision_initial"] == J.loc[row, "decision_effective_preclose"]
    J.loc[row, "n_revisions_preclose"] = "2"
    J.loc[row, "uncertain"] = "true"
    merged, checks = validate(bundle)
    assert merged.loc[(merged.case_id == case) & (merged.determination_level == level),
                      f"reviewer_{slot}_n_revisions_preclose"].iloc[0] == 2
    changed = pa4.build_results(merged, bundle[1], checks)
    before = baseline["reviewer_agreement_initial_submissions"][level]["n_case_levels_with_any_revision"]
    after = changed["reviewer_agreement_initial_submissions"][level]["n_case_levels_with_any_revision"]
    assert after == before + 1


def test_trial_performance_does_not_score_descriptor_status_as_trial_output(bundle):
    merged, _ = validate(bundle)
    trials = merged[merged.determination_level == "TRIAL_LEVEL"].copy()
    assert set(trials.curated_v11_status_raw) == {"CONTEXT_DEPENDENT"}
    # A correct Stage C classification remains a correct trial prediction even when
    # the upstream descriptor status requires trial context.
    trials["adjudicated_decision"] = trials.curated_v11_binary
    scored = pa3.classifier_vs_reference(trials, level="TRIAL_LEVEL")
    assert scored["curated_v11"]["confusion"]["fp"] == 0
    assert scored["curated_v11"]["confusion"]["fn"] == 0
    assert "curated_v11_four_category_exact_match" not in scored
    complete = results(bundle)
    for rule in pa3.DENOMINATOR_RULES:
        assert "curated_v11_four_category_exact_match" not in complete["accuracy"]["TRIAL_LEVEL"][rule]
        assert "curated_v11_four_category_exact_match" in complete["accuracy"]["DESCRIPTOR_LEVEL"][rule]
