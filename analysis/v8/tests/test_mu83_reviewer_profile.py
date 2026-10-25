"""Version and wording integrity; no real cases or study estimates."""
import hashlib
import csv
from pathlib import Path
import sys

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mu83_reviewer_profile as V83  # noqa: E402
import mu82_history as V82  # noqa: E402
import performance_analysis_v8 as P  # noqa: E402

GUIDE = Path(__file__).resolve().parents[3] / "docs/reviewer/REVIEWER_GUIDE_v81_r3.md"


@pytest.fixture
def profile(tmp_path):
    guide = GUIDE.read_bytes()
    assert hashlib.sha256(guide).hexdigest() == V83.GUIDE_SHA256
    (tmp_path / V83.GUIDE_FILE).write_bytes(guide)
    version = "SYN-8-1-PROFILE-TEST"
    binding = hashlib.sha256("|".join(["mu81-reviewer-profile-1", version, V83.PROFILE_ID,
                                      V83.GUIDE_SHA256]).encode()).hexdigest()
    manifest = {
        "bundle_format_version": "8.3", "design": {"design_version": version},
        "reviewer_profile": {"profile_id": V83.PROFILE_ID, "rubric_sha256": V83.GUIDE_SHA256,
                             "design_version": version, "binding_sha256": binding},
        "freeze": {"reviewer_profile_sha256": binding},
        "files": {V83.GUIDE_FILE: V83.GUIDE_SHA256}, "row_counts": {V83.GUIDE_FILE: 1},
    }
    return tmp_path, manifest


def test_bound_profile_metadata_matches_fixed_guide(profile):
    path, manifest = profile
    assert V83.verify_metadata(path, manifest, P.refuse_unless)


@pytest.mark.parametrize("section,key,value", [
    ("reviewer_profile", "profile_id", "unknown"),
    ("reviewer_profile", "rubric_sha256", "a" * 64),
    ("reviewer_profile", "binding_sha256", "b" * 64),
    ("reviewer_profile", "design_version", "SYN-8-1-DIFFERENT"),
    ("reviewer_profile", "attestation", "not an exported field"),
    ("design", "design_version", "review-design-v7.0.0"),
    ("freeze", "reviewer_profile_sha256", None),
    ("files", "reviewer_guide.md", "c" * 64),
    ("row_counts", "reviewer_guide.md", 0),
    ("row_counts", "reviewer_guide.md", True),
])
def test_metadata_tampering_refused(profile, section, key, value):
    path, manifest = profile
    manifest[section][key] = value
    with pytest.raises(P.Refused):
        V83.verify_metadata(path, manifest, P.refuse_unless)


def test_missing_profile_refused(profile):
    path, manifest = profile
    del manifest["reviewer_profile"]
    with pytest.raises(P.Refused):
        V83.verify_metadata(path, manifest, P.refuse_unless)


@pytest.mark.parametrize("kind", ["missing", "edited_with_new_checksum"])
def test_guide_cannot_be_replaced_or_omitted(profile, kind):
    path, manifest = profile
    guide = path / V83.GUIDE_FILE
    if kind == "missing":
        guide.unlink()
    else:
        guide.write_text("A different clinical policy.")
        manifest["files"][V83.GUIDE_FILE] = hashlib.sha256(guide.read_bytes()).hexdigest()
    with pytest.raises(P.Refused):
        V83.verify_metadata(path, manifest, P.refuse_unless)


@pytest.mark.parametrize("version", ["7.0", "8.1", "8.2"])
@pytest.mark.parametrize("retained", ["profile", "freeze", "file", "count", "physical_file"])
def test_legacy_format_cannot_silently_carry_profile(profile, version, retained):
    path, original = profile
    manifest = {"bundle_format_version": version, "freeze": {}, "files": {}, "row_counts": {}}
    if retained != "physical_file":
        (path / V83.GUIDE_FILE).unlink()
    if retained == "profile":
        manifest["reviewer_profile"] = original["reviewer_profile"]
    elif retained == "freeze":
        manifest["freeze"] = original["freeze"]
    elif retained == "file":
        manifest["files"] = original["files"]
    elif retained == "count":
        manifest["row_counts"] = original["row_counts"]
    with pytest.raises(P.Refused, match="format 8.3"):
        V83.verify_metadata(path, manifest, P.refuse_unless)


def test_legacy_unbound_is_unchanged(tmp_path):
    for version in ["7.0", "8.1", "8.2"]:
        assert not V83.verify_metadata(tmp_path, {"bundle_format_version": version}, P.refuse_unless)


@pytest.fixture
def endpoints():
    units = pd.DataFrame([
        {"unit_id": "SYN-KEEP", "family": "SG", "assignment_code": "K_KEEP_MALIGNANT_COMPATIBLE"},
        {"unit_id": "SYN-REMOVE", "family": "SG", "assignment_code": "K_REMOVE_VERIFIED_NONMALIGNANT"},
        {"unit_id": "SYN-AREA", "family": "AREA", "assignment_code": "AREA_IMMUNE"},
        {"unit_id": "SYN-D4", "family": "SG", "assignment_code": "D4A_KEEP_UNRESOLVED_PARENT_ONLY"},
    ])
    judgments = pd.DataFrame([{"unit_id": u, "answer_initial": "DISAGREE", "answer_effective": "DISAGREE",
                               "reason_initial": "OTHER_SPECIFIED", "reason_effective": "OTHER_SPECIFIED"}
                              for u in units.unit_id])
    references = pd.DataFrame([{"unit_id": u, "final_answer": "DISAGREE",
                                "adjudication_status": "DISCORDANT_RESOLVED", "adjudication_reason_code": "OTHER_SPECIFIED"}
                               for u in units.unit_id])
    return units, judgments, references


@pytest.mark.parametrize("source", ["reason_initial", "reason_effective", "adjudication_reason_code", "history"])
def test_new_reason_is_scoped_to_removed_neoplasm_unit(endpoints, source):
    units, judgments, references = endpoints
    for unit, allowed in [("SYN-KEEP", False), ("SYN-REMOVE", True), ("SYN-AREA", False), ("SYN-D4", False)]:
        j, r = judgments.copy(), references.copy()
        if source == "history":
            accepts = V83.verify_reasons(units, j, r, P.refuse_unless)
            assert accepts(unit, "DISAGREE", V83.NEW_REASON) is allowed
            continue
        target = r if source == "adjudication_reason_code" else j
        target.loc[target.unit_id == unit, source] = V83.NEW_REASON
        if allowed:
            V83.verify_reasons(units, j, r, P.refuse_unless)
        else:
            with pytest.raises(P.Refused):
                V83.verify_reasons(units, j, r, P.refuse_unless)


@pytest.mark.parametrize("unit,reason", [("SYN-KEEP", "BENIGN_NEOPLASM"), ("SYN-D4", "TYPE_2_STATED")])
def test_withdrawn_reason_cannot_enter_bound_profile(endpoints, unit, reason):
    units, judgments, references = endpoints
    judgments.loc[judgments.unit_id == unit, "reason_initial"] = reason
    with pytest.raises(P.Refused):
        V83.verify_reasons(units, judgments, references, P.refuse_unless)
    assert not V83.reason_validator(units)(unit, "DISAGREE", reason)


def test_reason_never_attaches_to_agree_or_cannot_tell(endpoints):
    accepts = V83.reason_validator(endpoints[0])
    for answer in ["AGREE", "CANNOT_TELL", ""]:
        assert not accepts("SYN-REMOVE", answer, V83.NEW_REASON)
        assert accepts("SYN-REMOVE", answer, "")


@pytest.mark.parametrize("source", ["reason_initial", "reason_effective", "adjudication_reason_code"])
def test_unbound_exports_refuse_new_reason(endpoints, source):
    _, judgments, references = endpoints
    V83.reject_unbound_profile_reasons(judgments, references, P.refuse_unless)
    target = references if source == "adjudication_reason_code" else judgments
    target.loc[target.unit_id == "SYN-REMOVE", source] = V83.NEW_REASON
    with pytest.raises(P.Refused, match="format 8.3"):
        V83.reject_unbound_profile_reasons(judgments, references, P.refuse_unless)


def test_profile_reason_is_checked_inside_full_history(tmp_path):
    def digest(text):
        return hashlib.sha256(text.encode()).hexdigest()
    row = {
        "unit_id": "SYN-REMOVE", "mode": "FORMAL", "assignment_id": "00000000-0000-4000-8000-000000000001",
        "reviewer_slot": "1", "reviewer_pseudo_id": "R-TST1", "revision_number": "1",
        "answer": "DISAGREE", "reason_code": V83.NEW_REASON, "note": "Fictional nonmalignant lesion.",
        "uncertain": "false", "seconds_on_unit": "30", "diabetes_subtype": "",
        "submitted_at_utc": "2026-10-25T12:00:00.000000Z",
    }
    base = digest("|".join(row[k] for k in ["assignment_id", "revision_number", "answer", "reason_code", "note", "uncertain", "seconds_on_unit"]))
    row["content_sha256"] = digest("mu81-judgment-1|" + base + "|")
    name = "judgment_history.csv"
    with (tmp_path / name).open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=V82.COLUMNS, lineterminator="\n")
        writer.writeheader()
        writer.writerow(row)
    subtype_columns = ["unit_id", "mode", "reviewer_slot", "revision_number", "answer", "diabetes_subtype", "content_sha256"]
    with (tmp_path / "subtype_observations.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=subtype_columns, lineterminator="\n")
        writer.writeheader()
        writer.writerow({k: row[k] for k in subtype_columns})
    snapshot_fields = ["unit_id", "reviewer_slot", "reviewer_pseudo_id", "revision_number", "answer", "reason_code", "note", "uncertain", "content_sha256", "submitted_at_utc"]
    manifest = {"history_contract_version": "mu81-history-1",
                "files": {name: hashlib.sha256((tmp_path / name).read_bytes()).hexdigest()},
                "row_counts": {name: 1},
                "snapshot": {"n_rows": 1, "content_sha256": digest("|".join(row[k] for k in snapshot_fields))}}
    judgment = {"unit_id": row["unit_id"], "mode": "FORMAL", "reviewer_slot": "1", "reviewer_pseudo_id": "R-TST1",
                "judgment_status": "ANSWERED", "n_revisions": "0", "first_submitted_at": "2026-10-25T12:00:00.000Z",
                "last_submitted_at": "2026-10-25T12:00:00.000Z"}
    for suffix in ["initial", "effective"]:
        for key, source in [("answer", "answer"), ("reason", "reason_code"), ("note", "note"), ("uncertain", "uncertain")]:
            judgment[key + "_" + suffix] = row[source]
    judgments = pd.DataFrame([judgment])
    units = pd.DataFrame([{"unit_id": "SYN-REMOVE", "family": "SG", "assignment_code": V83.REMOVE_CODE}])
    V82.verify(tmp_path, manifest, judgments, P.refuse_unless, V83.reason_validator(units))
    # Legacy histories do not gain the new reason merely because the new analyzer is installed.
    with pytest.raises(P.Refused):
        V82.verify(tmp_path, manifest, judgments, P.refuse_unless)
    units.loc[0, "assignment_code"] = "K_KEEP_MALIGNANT_COMPATIBLE"
    with pytest.raises(P.Refused):
        V82.verify(tmp_path, manifest, judgments, P.refuse_unless, V83.reason_validator(units))
