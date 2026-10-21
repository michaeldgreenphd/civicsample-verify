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


def write_rehashed_bundle(tmp_path, bundle):
    """Serialize altered synthetic inputs and rehash every file before loading them."""
    frames, manifest = bundle
    for entry in manifest["files"]:
        path = tmp_path / entry["name"]
        frame = frames[entry["role"]]
        frame.to_csv(path, index=False, lineterminator="\n")
        entry["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        entry["rows"] = len(frame)
        if entry["role"] == "frozen_predictions":
            manifest["frozen_prediction_set_sha256"] = entry["sha256"]
    path = tmp_path / fx.MANIFEST_NAME
    path.write_text(json.dumps(manifest), encoding="utf-8")
    return pa4.load_bundle(str(path))


@pytest.mark.parametrize("column,value", [
    ("unit_type", "TRIAL_AREA"), ("unit_id", "SYN-OTHER-UNIT"),
    ("nct_id", "SYN-NCT-9999"), ("descriptor_ui", "SYN-OTHER-DESCRIPTOR"),
    ("area", "respiratory"),
])
def test_rehashed_judgment_case_metadata_must_match_predictions(bundle, tmp_path, column, value):
    J = bundle[0]["independent_judgments"]
    case = J.iloc[0].case_id
    assert not J.loc[J.case_id == case, column].eq(value).any()
    J.loc[J.case_id == case, column] = value
    changed = write_rehashed_bundle(tmp_path, bundle)
    with pytest.raises(pa4.ExportError, match=f"{column} differs from frozen prediction"):
        validate(changed)


@pytest.mark.parametrize("column", ["unit_type", "unit_id", "descriptor_ui", "descriptor_name", "area", "nct_id"])
def test_rehashed_judgments_cannot_disagree_on_case_metadata(bundle, tmp_path, column):
    J = bundle[0]["independent_judgments"]
    J.loc[0, column] = "SYN-OTHER-METADATA"
    changed = write_rehashed_bundle(tmp_path, bundle)
    with pytest.raises(pa4.ExportError, match=f"{column} must stay consistent"):
        validate(changed)


@pytest.mark.parametrize("column", ["unit_type", "unit_id", "descriptor_ui", "area", "nct_id"])
def test_metadata_cannot_change_between_trial_determination_levels(bundle, tmp_path, column):
    P = bundle[0]["frozen_predictions"]
    row = P.index[P.determination_level == "TRIAL_LEVEL"][0]
    P.loc[row, column] = "SYN-OTHER-METADATA"
    changed = write_rehashed_bundle(tmp_path, bundle)
    with pytest.raises(pa4.ExportError, match=f"{column} must stay consistent"):
        validate(changed)


@pytest.mark.parametrize("missing", ["", "  ", None, "0", "-1", "1.5", "unknown"])
def test_rehashed_judgments_require_a_positive_case_version(bundle, tmp_path, missing):
    bundle[0]["independent_judgments"].loc[0, "case_version"] = missing
    changed = write_rehashed_bundle(tmp_path, bundle)
    with pytest.raises(pa4.ExportError, match="case_version must be a nonmissing positive integer"):
        validate(changed)


def test_rehashed_judgments_cannot_mix_case_versions_between_reviewers(bundle, tmp_path):
    bundle[0]["independent_judgments"].loc[0, "case_version"] = "2"
    with pytest.raises(pa4.ExportError, match="case_version must agree"):
        validate(write_rehashed_bundle(tmp_path, bundle))


def test_rehashed_judgments_cannot_mix_case_versions_between_trial_steps(bundle, tmp_path):
    J = bundle[0]["independent_judgments"]
    case = J.loc[J.determination_level == "TRIAL_LEVEL", "case_id"].iloc[0]
    J.loc[(J.case_id == case) & (J.determination_level == "TRIAL_LEVEL"), "case_version"] = "2"
    with pytest.raises(pa4.ExportError, match="case_version must agree"):
        validate(write_rehashed_bundle(tmp_path, bundle))


def test_case_version_is_preserved_without_inventing_a_frozen_version(bundle, tmp_path):
    J, P, A = (bundle[0][name] for name in ("independent_judgments", "frozen_predictions", "adjudicated_reference"))
    case = J.loc[J.determination_level == "TRIAL_LEVEL", "case_id"].iloc[0]
    J.loc[J.case_id == case, "case_version"] = "7"
    assert "case_version" not in P.columns and "case_version" not in A.columns
    merged, _ = validate(write_rehashed_bundle(tmp_path, bundle))
    assert set(merged.loc[merged.case_id == case, "case_version"]) == {7}
    # Descriptor cases legitimately have no NCT identifier in either source.
    descriptors = merged[merged.unit_type == "DESCRIPTOR_AREA"]
    assert descriptors.nct_id.isna().all()


@pytest.mark.parametrize("missing", ["", "  ", None])
def test_rehashed_predictions_require_nonblank_frame_unit_identity(bundle, tmp_path, missing):
    bundle[0]["frozen_predictions"].loc[0, "frame_unit_id"] = missing
    with pytest.raises(pa4.ExportError, match="frame_unit_id must be nonblank"):
        validate(write_rehashed_bundle(tmp_path, bundle))


def test_rehashed_predictions_cannot_count_one_frame_unit_as_two_cases(bundle, tmp_path):
    P = bundle[0]["frozen_predictions"]
    first, second = P.case_id.unique()[:2]
    frame_unit = P.loc[P.case_id == first, "frame_unit_id"].iloc[0]
    P.loc[P.case_id == second, "frame_unit_id"] = frame_unit
    with pytest.raises(pa4.ExportError, match="frame_unit_id must identify only one case"):
        validate(write_rehashed_bundle(tmp_path, bundle))


def test_rehashed_trial_predictions_cannot_switch_frame_units_between_levels(bundle, tmp_path):
    P = bundle[0]["frozen_predictions"]
    row = P.index[P.determination_level == "TRIAL_LEVEL"][0]
    P.loc[row, "frame_unit_id"] = "FX-OTHER-FRAME-UNIT"
    with pytest.raises(pa4.ExportError, match="frame_unit_id must stay consistent"):
        validate(write_rehashed_bundle(tmp_path, bundle))


@pytest.mark.parametrize("status", ["DISCORDANT_RESOLVED", "UNRESOLVED_ESCALATED", "CONCORDANT_ADOPTED_BY_RULE"])
@pytest.mark.parametrize("missing", ["", "  ", None])
def test_rehashed_reference_requires_adjudicator_identity(bundle, tmp_path, status, missing):
    A = bundle[0]["adjudicated_reference"]
    A.loc[A.index[A.adjudication_status == status][0], "adjudicator_pseudo_id"] = missing
    with pytest.raises(pa4.ExportError, match="adjudicator_pseudo_id must be nonblank"):
        validate(write_rehashed_bundle(tmp_path, bundle))


@pytest.mark.parametrize("role", ["", "  ", None, "REVIEWER", "CONCORDANCE_RULE", "unknown"])
@pytest.mark.parametrize("allow_exposed", [False, True])
def test_rehashed_human_reference_requires_recognized_role(bundle, tmp_path, role, allow_exposed):
    A = bundle[0]["adjudicated_reference"]
    A.loc[A.index[A.adjudication_status == "DISCORDANT_RESOLVED"][0], "adjudicator_role"] = role
    with pytest.raises(pa4.ExportError, match="non-rule adjudicator_role"):
        validate(write_rehashed_bundle(tmp_path, bundle), allow_exposed_reference=allow_exposed)


def test_investigator_role_cannot_claim_blinded_primary_reference(bundle, tmp_path):
    A = bundle[0]["adjudicated_reference"]
    row = A.index[A.adjudication_status == "DISCORDANT_RESOLVED"][0]
    A.loc[row, "adjudicator_role"] = "INVESTIGATOR"
    with pytest.raises(pa4.ExportError, match="INVESTIGATOR adjudication must explicitly record exposure"):
        validate(write_rehashed_bundle(tmp_path, bundle))
    A.loc[row, ["adjudicator_exposed_to_index_labels", "adjudication_blinded"]] = ["true", "false"]
    changed = write_rehashed_bundle(tmp_path, bundle)
    with pytest.raises(pa4.ExportError, match="exposed"):
        validate(changed)
    merged, _ = validate(changed, allow_exposed_reference=True)
    assert (merged.adjudicator_role == "INVESTIGATOR").sum() == 1


@pytest.mark.parametrize("field", [key for key in pa4.MANIFEST_KEYS_V4 if key.endswith("sha256")])
@pytest.mark.parametrize("digest", ["unknown", "", None, "a" * 63, "g" * 64, "A" * 64])
def test_manifest_provenance_hashes_require_sha256_syntax(bundle, field, digest):
    bundle[1][field] = digest
    with pytest.raises(pa4.ExportError, match=f"manifest {field} must be a 64-character lowercase SHA-256 digest"):
        validate(bundle)


@pytest.mark.parametrize("role", sorted(pa4.FILE_ROLES))
@pytest.mark.parametrize("digest", ["unknown", None, "a" * 63, "G" * 64])
def test_manifest_file_hashes_require_sha256_syntax(bundle, role, digest):
    entry = next(entry for entry in bundle[1]["files"] if entry["role"] == role)
    entry["sha256"] = digest
    with pytest.raises(pa4.ExportError, match="every manifest file sha256"):
        validate(bundle)


def test_loading_refuses_malformed_provenance_before_analysis(tmp_path):
    manifest = fx.write(tmp_path)
    manifest["ontology_sha256"] = "unknown"
    path = tmp_path / fx.MANIFEST_NAME
    path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(pa4.ExportError, match="ontology_sha256 must be a 64-character lowercase SHA-256 digest"):
        pa4.load_bundle(str(path))


@pytest.mark.parametrize("status", ["EXLCUDE", "unknown", "CONTEXT_DEPENDENT", "include", "0"])
def test_rehashed_unknown_stage_c_status_cannot_retain_tier0(bundle, tmp_path, status):
    P = bundle[0]["frozen_predictions"]
    row = P.index[P.determination_level == "TRIAL_LEVEL"][0]
    P.loc[row, "stage_c_trial_status"] = status
    # Without vocabulary validation, this wrong value used the fallback and passed.
    P.loc[row, "tier1_binary"] = P.loc[row, "tier0_binary"]
    with pytest.raises(pa4.ExportError, match="stage_c_trial_status must be blank"):
        validate(write_rehashed_bundle(tmp_path, bundle))


@pytest.mark.parametrize("status", ["", None, "UNRESOLVED", "INCLUDE", "EXCLUDE"])
def test_known_stage_c_statuses_keep_the_defined_mapping(bundle, tmp_path, status):
    P = bundle[0]["frozen_predictions"]
    row = P.index[P.determination_level == "TRIAL_LEVEL"][0]
    P.loc[row, "stage_c_trial_status"] = status
    expected = status if status in ("INCLUDE", "EXCLUDE") else P.loc[row, "tier0_binary"]
    P.loc[row, "tier1_binary"] = expected
    merged, _ = validate(write_rehashed_bundle(tmp_path, bundle))
    actual = merged.loc[(merged.case_id == P.loc[row, "case_id"]) &
                        (merged.determination_level == "TRIAL_LEVEL"), "curated_v11_binary"].iloc[0]
    assert actual == expected


@pytest.mark.parametrize("column,value", [
    ("selection_stratum", "FX-OTHER-SELECTION"),
    ("variance_stratum", "FX-OTHER-VARIANCE"),
    ("variance_stratum_size", "21"),
    ("selection_probability", "0.200000000000000000000000001"),
    ("sampling_weight", "5.000000000000000000000000001"),
    ("comparison_cell", "FX-OTHER-COMPARISON"),
    ("impact_tier", "HIGH"),
    ("policy_governed_neoplasm_GEN06", "true"),
])
def test_rehashed_sampling_design_cannot_change_between_trial_levels(bundle, tmp_path, column, value):
    P = bundle[0]["frozen_predictions"]
    row = P.index[P.determination_level == "TRIAL_LEVEL"][0]
    assert P.loc[row, column] != value
    P.loc[row, column] = value
    with pytest.raises(pa4.ExportError, match=f"{column} must stay consistent"):
        validate(write_rehashed_bundle(tmp_path, bundle))


def test_rehashed_case_cannot_use_different_valid_probability_weight_pairs(bundle, tmp_path):
    P = bundle[0]["frozen_predictions"]
    row = P.index[P.determination_level == "TRIAL_LEVEL"][0]
    P.loc[row, ["selection_probability", "sampling_weight"]] = ["0.25", "4"]
    with pytest.raises(pa4.ExportError, match="selection_probability must stay consistent"):
        validate(write_rehashed_bundle(tmp_path, bundle))


def test_equivalent_numeric_sampling_encodings_are_the_same_design(bundle, tmp_path):
    P = bundle[0]["frozen_predictions"]
    row = P.index[P.determination_level == "TRIAL_LEVEL"][0]
    assert P.loc[row, "selection_probability"] == "0.2"
    assert float(P.loc[row, "sampling_weight"]) == 5
    assert int(P.loc[row, "variance_stratum_size"]) == 20
    P.loc[row, ["selection_probability", "sampling_weight", "variance_stratum_size"]] = ["0.2000", "5e0", "20.00"]
    merged, _ = validate(write_rehashed_bundle(tmp_path, bundle))
    case = merged[merged.case_id == P.loc[row, "case_id"]]
    assert set(case.selection_probability) == {0.2}
    assert set(case.sampling_weight) == {5.0}
    assert set(case.variance_stratum_size) == {20.0}


def test_nullable_comparison_cell_is_consistent_when_absent_on_both_levels(bundle, tmp_path):
    P = bundle[0]["frozen_predictions"]
    case = P.loc[P.determination_level == "TRIAL_LEVEL", "case_id"].iloc[0]
    P.loc[P.case_id == case, "comparison_cell"] = None
    validate(write_rehashed_bundle(tmp_path, bundle))


def test_missing_comparison_cell_on_only_one_trial_level_is_inconsistent(bundle, tmp_path):
    P = bundle[0]["frozen_predictions"]
    row = P.index[P.determination_level == "TRIAL_LEVEL"][0]
    P.loc[row, "comparison_cell"] = None
    with pytest.raises(pa4.ExportError, match="comparison_cell must stay consistent"):
        validate(write_rehashed_bundle(tmp_path, bundle))
