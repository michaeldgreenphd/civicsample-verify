"""Verify the opt-in reviewer guide and vocabulary without changing legacy bundles.

The fixed guide hash is an engineering contract, not approval of a sample, gate,
estimator, or clinical result. Registered manifest verification remains separate.
"""
from __future__ import annotations
import hashlib

PROFILE_ID = "mu81-plain-language-r3"
GUIDE_SHA256 = "1cd8584d68a313e60aab2f5e03f36fba66105c31b0050dec1be7d8f36ddba284"
GUIDE_FILE = "reviewer_guide.md"
KEEP_CODES = {"K_KEEP_MALIGNANT_COMPATIBLE", "K_KEEP_HEURISTIC_NONMALIGNANT_CLASS"}
REMOVE_CODE = "K_REMOVE_VERIFIED_NONMALIGNANT"
NEW_REASON = "NONMALIGNANT_NEOPLASM_STUDIED"
AREA_REASONS = {"ORGAN_OF_ORIGIN_ONLY", "NOT_THE_CONDITION_STUDIED", "MESH_PLACEMENT_MISLEADING",
                "RUBRIC_POLICY_EXCLUDES", "OTHER_SPECIFIED"}
ROW_REASONS = {"NOT_THE_CONDITION_STUDIED", "MESH_PLACEMENT_MISLEADING", "OTHER_SPECIFIED"}
SUBGROUP_REASONS = {
    "D1_KEEP_TYPE2": {"TYPE_1_ONLY", "OTHER_DIABETES_TYPE", "PREDIABETES_ONLY", "DIABETES_NOT_STUDIED", "OTHER_SPECIFIED"},
    "D4A_KEEP_UNRESOLVED_PARENT_ONLY": {"TYPE_1_ONLY", "OTHER_DIABETES_TYPE", "PREDIABETES_ONLY", "DIABETES_NOT_STUDIED", "OTHER_SPECIFIED"},
    "D4B_KEEP_UNRESOLVED_COMPLICATION_ONLY": {"TYPE_1_ONLY", "OTHER_DIABETES_TYPE", "PREDIABETES_ONLY", "DIABETES_NOT_STUDIED", "OTHER_SPECIFIED"},
    "D2_REMOVE_OTHER_TYPE": {"TYPE_2_STUDIED", "TYPE_NOT_DETERMINABLE", "OTHER_SPECIFIED"},
    "D3_REMOVE_PREDIABETES_ONLY": {"DIABETES_STUDIED", "OTHER_SPECIFIED"},
    "K_KEEP_MALIGNANT_COMPATIBLE": {"PRECANCEROUS", "NOT_A_NEOPLASM", "OTHER_SPECIFIED"},
    "K_KEEP_HEURISTIC_NONMALIGNANT_CLASS": {"PRECANCEROUS", "NOT_A_NEOPLASM", "OTHER_SPECIFIED"},
    REMOVE_CODE: {"MALIGNANT_NEOPLASM_STUDIED", NEW_REASON, "OTHER_SPECIFIED"},
}


def verify_metadata(path, manifest, require):
    """Return whether this is a checked profile, rejecting downgrade markers too."""
    active = str(manifest.get("bundle_format_version")) == "8.3"
    profile = manifest.get("reviewer_profile")
    freeze = manifest.get("freeze") or {}
    files = manifest.get("files") or {}
    counts = manifest.get("row_counts") or {}
    if not active:
        require(profile is None and freeze.get("reviewer_profile_sha256") is None
                and GUIDE_FILE not in files and GUIDE_FILE not in counts
                and not (path / GUIDE_FILE).exists(),
                "reviewer profile requires bundle format 8.3")
        return False
    require(isinstance(profile, dict)
            and set(profile) == {"profile_id", "rubric_sha256", "binding_sha256", "design_version"},
            "reviewer profile metadata is missing or invalid")
    require(profile["profile_id"] == PROFILE_ID and profile["rubric_sha256"] == GUIDE_SHA256,
            "unknown reviewer profile or guide")
    version = (manifest.get("design") or {}).get("design_version")
    require(isinstance(version, str) and (version == "review-design-v8.1.0" or version.startswith("SYN-8-1-"))
            and profile["design_version"] == version, "reviewer profile design mismatch")
    digest = hashlib.sha256("|".join(["mu81-reviewer-profile-1", version, PROFILE_ID, GUIDE_SHA256]).encode()).hexdigest()
    require(profile["binding_sha256"] == digest == freeze.get("reviewer_profile_sha256"),
            "reviewer profile differs from freeze")
    require((path / GUIDE_FILE).is_file(), "missing bound reviewer guide")
    require(hashlib.sha256((path / GUIDE_FILE).read_bytes()).hexdigest() == GUIDE_SHA256
            and files.get(GUIDE_FILE) == GUIDE_SHA256 and type(counts.get(GUIDE_FILE)) is int
            and counts[GUIDE_FILE] == 1, "reviewer guide checksum or count mismatch")
    return True


def reason_validator(units):
    """The database's profile-specific allowed reasons, selected by each unit."""
    allowed = {}
    for unit in units.itertuples():
        allowed[unit.unit_id] = (AREA_REASONS if unit.family == "AREA" else
                                 ROW_REASONS if unit.family == "ROW" else
                                 SUBGROUP_REASONS.get(unit.assignment_code, set()))

    def accepts(unit_id, answer, reason):
        return (reason in allowed.get(unit_id, set()) if answer == "DISAGREE" else reason == "")
    return accepts


def verify_reasons(units, judgments, references, require):
    accepts = reason_validator(units)
    for row in judgments.itertuples():
        for suffix in ("initial", "effective"):
            require(accepts(row.unit_id, getattr(row, f"answer_{suffix}"), getattr(row, f"reason_{suffix}")),
                    "reviewer reason is invalid for the bound profile and assignment")
    for row in references.itertuples():
        # Non-adjudicated final references have no adjudication reason.
        answer = row.final_answer if row.adjudication_status == "DISCORDANT_RESOLVED" else ""
        require(accepts(row.unit_id, answer, row.adjudication_reason_code),
                "adjudicator reason is invalid for the bound profile and assignment")
    return accepts


def reject_unbound_profile_reasons(judgments, references, require):
    for column in ("reason_initial", "reason_effective"):
        require(not judgments[column].eq(NEW_REASON).any(), "profile reason requires bundle format 8.3")
    require(not references.adjudication_reason_code.eq(NEW_REASON).any(),
            "profile reason requires bundle format 8.3")
