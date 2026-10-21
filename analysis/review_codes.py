"""SYNTHETIC ENGINEERING ONLY. Proposed analysis; no clinical study results."""

from __future__ import annotations

from typing import Dict, List

REVIEW_CODES_VERSION = "1.2.0"

# Validity layers. Keys match the layer object names in CLASSIFICATION_SCHEMA.json
# (clinical_classification, benchmark_compatibility, analytical_ppr_validity).
# Reviewers always choose from four options per applicable layer. The two
# caveat statuses used by the AI stages (COMPATIBLE_WITH_CAVEAT,
# VALID_WITH_CAVEAT) are captured for reviewers as the directional code plus a
# separate caveat flag and caveat text.
LAYERS: Dict[str, Dict[str, object]] = {
    "clinical_classification": {
        "short": "L1",
        "label": "clinical classification",
        "question": ("Does the condition (the MeSH descriptor, or the trial's use of it) belong to the "
                     "therapeutic area's intended clinical construct?"),
        "codes": ["INCLUDE", "EXCLUDE", "CONTEXT_DEPENDENT", "INSUFFICIENT_INFORMATION"],
        "positive": "INCLUDE",
        "negative": "EXCLUDE",
        "has_caveat": False,
    },
    "benchmark_compatibility": {
        "short": "L2",
        "label": "benchmark compatibility",
        "question": ("Does the prevalence benchmark of the PPR condition row describe this population: "
                     "disease definition, age and sex strata, population type, calendar period, and "
                     "prevention or treatment context?"),
        "codes": ["COMPATIBLE", "INCOMPATIBLE", "CONTEXT_DEPENDENT", "INSUFFICIENT_INFORMATION"],
        "positive": "COMPATIBLE",
        "negative": "INCOMPATIBLE",
        "has_caveat": True,
    },
    "analytical_ppr_validity": {
        "short": "L3",
        "label": "PPR interpretability",
        "question": ("Given the classification and benchmark shown, is a participation-to-prevalence "
                     "ratio computed for these trials interpretable as a measure of female representation?"),
        "codes": ["VALID", "INVALID", "CONTEXT_DEPENDENT", "INSUFFICIENT_INFORMATION"],
        "positive": "VALID",
        "negative": "INVALID",
        "has_caveat": True,
    },
}

LAYER_IDS: List[str] = list(LAYERS)
NOT_APPLICABLE = "NOT_APPLICABLE"  # export-only token for state 3 (layer absent for the case)

# Dependency rule mirrored from CLINICAL_ONTOLOGY.yaml (PPR-INV-02) and the
# allOf constraints in CLASSIFICATION_SCHEMA.json: when a reviewer records
# benchmark_compatibility = INCOMPATIBLE, that reviewer's analytical_ppr_validity
# is set to INVALID automatically and flagged as derived. Primary PPR
# interpretability agreement uses only cases where neither reviewer's decision
# was derived (VALIDATION_PLAN.md).
DERIVED_RULES = {
    ("benchmark_compatibility", "INCOMPATIBLE"): ("analytical_ppr_validity", "INVALID"),
}

# Mapping from AI-stage statuses (CLASSIFICATION_SCHEMA.json) to reviewer codes,
# used only to compare AI decisions with reviewer or adjudicated decisions.
# A value of None means "no comparison": the layer was not presented to
# reviewers for that status (no measured benchmark to judge, or not applicable).
# Unknown statuses raise an error instead of being dropped.
AI_TO_REVIEW_CODE: Dict[str, Dict[str, object]] = {
    "clinical_classification": {
        "INCLUDE": "INCLUDE",
        "EXCLUDE": "EXCLUDE",
        "CONTEXT_DEPENDENT": "CONTEXT_DEPENDENT",
        "INSUFFICIENT_EVIDENCE": "INSUFFICIENT_INFORMATION",
        "INSUFFICIENT_INFORMATION": "INSUFFICIENT_INFORMATION",
    },
    "benchmark_compatibility": {
        "COMPATIBLE": "COMPATIBLE",
        "COMPATIBLE_WITH_CAVEAT": "COMPATIBLE",
        "INCOMPATIBLE": "INCOMPATIBLE",
        "CONTEXT_DEPENDENT": "CONTEXT_DEPENDENT",
        "INSUFFICIENT_EVIDENCE": "INSUFFICIENT_INFORMATION",
        "INSUFFICIENT_INFORMATION": "INSUFFICIENT_INFORMATION",
        "NOT_ESTIMABLE": None,    # no measured benchmark: layer not presented to reviewers
        "NOT_APPLICABLE": None,   # descriptor feeds no PPR row
        "NOT_RUN": None,
    },
    "analytical_ppr_validity": {
        "VALID": "VALID",
        "VALID_WITH_CAVEAT": "VALID",
        "INVALID": "INVALID",
        "CONTEXT_DEPENDENT": "CONTEXT_DEPENDENT",
        "INSUFFICIENT_EVIDENCE": "INSUFFICIENT_INFORMATION",
        "INSUFFICIENT_INFORMATION": "INSUFFICIENT_INFORMATION",
        "NOT_APPLICABLE": None,
        "NOT_RUN": None,
    },
}

# Stage C (trial-level resolution) uses trial_area_status INCLUDE / EXCLUDE /
# INSUFFICIENT_EVIDENCE, mapped through the clinical_classification table.
# Optional reviewer field for trial-level cases, same enum as Stage C trial_role.
TRIAL_ROLES: List[str] = ["DISEASE_STUDIED", "COMORBIDITY", "COMPLICATION", "OUTCOME_ONLY",
                          "PREVENTION_TARGET", "RISK_FACTOR", "OTHER", "UNRESOLVABLE"]

# Therapeutic areas (CLASSIFICATION_SCHEMA.json `area` enum) and rule prefixes.
AREAS: Dict[str, str] = {
    "oncology": "ONC", "cardiovascular": "CV", "mental_health": "MH", "infectious": "INF",
    "metabolic": "MET", "neurological": "NEU", "respiratory": "RESP",
}

# Unit of review. Agreement and accuracy are reported separately for
# descriptor-level and trial-level units and never pooled across them.
CASE_UNITS: Dict[str, str] = {
    "DESCRIPTOR_AREA": "descriptor-level",  # unit_id = <descriptor_ui>::<area> (REVIEW_SAMPLE.csv unit_type)
    "TRIAL_AREA": "trial-level",            # one NCT trial carrying the descriptor, judged for the area
}

MODES = ["PILOT", "FORMAL"]
PILOT_CASE_PREFIX = "SYN-"           # every PILOT case_id starts with this; no FORMAL case_id may
TEST_FIXTURE_CASE_PREFIX = "TESTFX-"  # synthetic FORMAL-mode test fixtures only

ADJUDICATION_STATUSES = [
    "CONCORDANT_CONFIRMED",     # reviewers agreed; investigator confirmed the shared decision
    "CONCORDANT_REVISED",       # reviewers agreed; investigator recorded a different decision with rationale
    "DISCORDANT_RESOLVED",      # reviewers disagreed; investigator recorded a decision
    "UNRESOLVED_ESCALATED",     # no decision could be reached; escalated (see REVIEW_PROTOCOL.md)
]

ADJUDICATION_BASES = [
    "REVIEWER_1",       # adopted reviewer 1's decision
    "REVIEWER_2",       # adopted reviewer 2's decision
    "BOTH_REVIEWERS",   # both reviewers gave this decision
    "NEITHER",          # investigator decision differs from both reviewers
    "NONE",             # used only with UNRESOLVED_ESCALATED
]

REVIEW_PHASE_STATUSES = ["IN_PROGRESS", "COMPLETE", "CLOSED_INCOMPLETE"]

# Columns of the FORMAL analysis export (one row per case x applicable layer).
# fill_clinical_review_results.py requires every column listed here.
ANALYSIS_EXPORT_COLUMNS: List[str] = [
    "export_id", "mode", "is_pilot", "case_id", "case_version", "unit_type", "unit_id", "layer",
    "primary_stratum", "selection_probability", "sampling_weight", "frame_stratum_size",
    "descriptor_ui", "descriptor_name", "area", "nct_id", "condition_row", "benchmark_id",
    "trial_frequency_weight", "n_trials_primary",
    "original_decision",
    "ai_stage_a_status_raw", "ai_stage_a_decision",
    "ai_stage_b_status_raw", "ai_stage_b_decision",
    "ai_stage_c_status_raw", "ai_stage_c_decision",
    "decision_file_status_raw", "decision_file_decision",
    "reviewer_1_pseudo_id", "reviewer_1_review_id", "reviewer_1_revision_number",
    "reviewer_1_decision", "reviewer_1_derived", "reviewer_1_caveat", "reviewer_1_uncertain",
    "reviewer_1_submitted_at",
    "reviewer_2_pseudo_id", "reviewer_2_review_id", "reviewer_2_revision_number",
    "reviewer_2_decision", "reviewer_2_derived", "reviewer_2_caveat", "reviewer_2_uncertain",
    "reviewer_2_submitted_at",
    "double_reviewed", "reviewers_agree",
    "adjudication_id", "adjudicated_decision", "adjudicated_caveat", "adjudication_status",
    "adjudication_basis", "adjudicated_at", "approved_for_pipeline",
    "ontology_version", "rule_version", "rubric_version", "sampling_design_version",
]

MANIFEST_REQUIRED_KEYS: List[str] = [
    "export_id", "export_type", "export_format_version", "mode", "created_at",
    "app_git_sha", "db_schema_version", "ontology_version", "rule_version", "rubric_version",
    "classification_schema_version", "sampling_design_version", "review_phase_status",
    "files", "is_synthetic_fixture",
]

EXPORT_FORMAT_VERSION = "1.0"


def layer_codes(layer: str) -> List[str]:
    """Allowed reviewer codes for a layer."""
    return list(LAYERS[layer]["codes"])  # type: ignore[index]


def map_ai_code(layer: str, value: object) -> object:
    """Map an AI or analyst status to the layer's review code; None stays None."""
    if value is None or (isinstance(value, float) and value != value) or str(value).strip() == "":
        return None
    v = str(value).strip()
    table = AI_TO_REVIEW_CODE[layer]
    if v == NOT_APPLICABLE:
        return None
    if v not in table:
        raise ValueError(f"unknown status {v!r} for layer {layer}; add it to AI_TO_REVIEW_CODE explicitly")
    return table[v]


def derived_decision(layer: str, decisions: Dict[str, object]) -> object:
    """Return the decision a dependency rule forces for `layer`, or None.

    `decisions` maps layer -> the reviewer's decision for the other layers.
    """
    for (src_layer, src_code), (dst_layer, dst_code) in DERIVED_RULES.items():
        if dst_layer == layer and decisions.get(src_layer) == src_code:
            return dst_code
    return None


# Reverse mapping for the APPROVED_DECISIONS export. Layer 1 uses the decision
# file's human_override vocabulary (DECISION_FILE_v1.csv and
# TRIAL_LEVEL_DECISIONS_v1.csv: INCLUDE, EXCLUDE, RETAIN_ORIGINAL). An adjudicated
# INSUFFICIENT_INFORMATION keeps the original technical membership
# (RETAIN_ORIGINAL), matching the ontology's deterministic mapping policy; an
# adjudicated CONTEXT_DEPENDENT has no descriptor-level override and must be
# resolved trial by trial (returns None). Layers 2 and 3 are expressed in the
# AI-stage vocabulary (caveat flags become the *_WITH_CAVEAT statuses).
DECISION_FILE_OVERRIDE_VALUES: List[str] = ["INCLUDE", "EXCLUDE", "RETAIN_ORIGINAL"]


def review_to_decision_file_status(layer: str, code: object, caveat: object = None) -> object:
    if code is None or str(code).strip() == "":
        return None
    c = str(code).strip()
    if c not in LAYERS[layer]["codes"]:  # type: ignore[operator]
        raise ValueError(f"{c!r} is not a reviewer code for {layer}")
    cav = caveat is True or str(caveat).strip().lower() in ("true", "t", "1", "yes")
    if layer == "clinical_classification":
        return {"INCLUDE": "INCLUDE", "EXCLUDE": "EXCLUDE", "INSUFFICIENT_INFORMATION": "RETAIN_ORIGINAL",
                "CONTEXT_DEPENDENT": None}[c]
    if c == "INSUFFICIENT_INFORMATION":
        return "INSUFFICIENT_EVIDENCE"
    if layer == "benchmark_compatibility" and c == "COMPATIBLE" and cav:
        return "COMPATIBLE_WITH_CAVEAT"
    if layer == "analytical_ppr_validity" and c == "VALID" and cav:
        return "VALID_WITH_CAVEAT"
    return c


APPROVED_DECISIONS_COLUMNS: List[str] = [
    "export_id", "mode", "case_id", "unit_type", "unit_id", "descriptor_ui", "area", "nct_id", "layer",
    "adjudicated_decision", "adjudicated_caveat", "human_override_status", "adjudication_status",
    "adjudication_id", "decided_at", "ontology_version", "rule_version", "rubric_version",
]

# Case import format (SYNTHETIC_REVIEW_CASES.csv; REVIEW_SAMPLE.csv is mapped to it by an adapter).
# Routing: columns starting with "design_" go to case_design (investigator only); columns starting
# with "ai_" go to ai_classifications (investigator only); every other column builds the reviewer
# packet. Unknown columns stop the import.
CASE_IMPORT_PACKET_COLUMNS: List[str] = [
    "case_id", "mode", "unit_type", "unit_id", "area", "area_label", "case_title", "descriptor_ui",
    "descriptor_name", "mesh_scope_note", "mesh_tree_numbers", "mesh_entry_terms", "nlm_url",
    "l1_applicable", "l2_applicable", "l3_applicable", "synthetic_notice", "nct_id", "ctgov_url",
    "trial_brief_title", "trial_conditions", "trial_mesh_headings", "trial_brief_summary",
    "trial_primary_purpose", "trial_phase", "trial_eligibility_sex", "trial_min_age", "trial_max_age",
    "trial_interventions", "trial_primary_outcomes", "trial_enrollment", "sex_measure_state",
    "n_female", "n_male", "n_unknown_sex", "trial_female_share", "ppr_condition_row", "benchmark_id",
    "benchmark_value", "benchmark_value_type", "benchmark_source", "benchmark_case_definition",
    "benchmark_population_type", "benchmark_age_strata", "benchmark_calendar_year", "ppr_value",
]
CASE_IMPORT_DESIGN_COLUMNS: List[str] = [
    "design_frame_unit_id", "design_primary_stratum", "design_selection_probability", "design_frame_stratum_size",
    "design_sampling_design_version", "design_sampling_seed", "design_trial_frequency_weight",
    "design_n_trials_primary", "design_original_l1_decision", "design_original_l2_decision",
    "design_original_l3_decision", "design_investigator_note",
]
CASE_IMPORT_AI_COLUMNS: List[str] = [
    "ai_stage_a_l1_status", "ai_stage_a_l2_status", "ai_stage_a_l3_status",
    "ai_stage_b_l1_status", "ai_stage_b_l2_status", "ai_stage_b_l3_status",
    "ai_stage_c_l1_status", "ai_decision_file_l1_status", "ai_stage_a_rationale",
]
