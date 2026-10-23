#!/usr/bin/env python3
"""
tools/check_public_repo_leakage_v7.py  (handoff v7, the mapping-unit design)

Runs every check of tools/check_public_repo_leakage_v6.py (and through it the v5, v4, v3 and v2 checkers, imported
unchanged from the same folder), with the v7 additions below. Exit 0 when clean, 1 when any violation is found.

Why: the reviewers see each unit's trial, NCT ID and registry link inside the app, but the public repository carries
no study data. The unit sample, the frozen assignments, the queues, the frames, the provenance audit, the worked-example
packets and every private import file stay in data_private/ on the investigator's or developer's machine.

v7 additions
  Names (never committed): MAPPING_UNITS_v7*, FROZEN_ASSIGNMENTS_v7*, QUEUE_ORDER_v7*, freeze_manifest_v7*,
  MU7_IMPORT_*, FRAMES_v7*, PROVENANCE_AUDIT_v7*, CALIBRATION_TRIALS_AUDIT_v7*, TRAINING_UNITS_v7*,
  WORKED_EXAMPLES_v7*, UNIT_PROBABILITIES_ONE_PER_TRIAL_v7*, PATTERN_GROUP_PROBABILITIES_v7*, any *_PRIVATE.* file,
  CLAUDE_CODE_SCIENTIFIC_CONTRACT_v7*, claude_code_private_staging_v7*, real v7 bundles and results
  (bundle_v7*, performance_results_v7*), the private dry-run results (dry_run_private_v7_results*), and the design
  scripts of review_design_v7 (v7_common.py, steps 00 to 09, run_all_v7.sh), which stay in the investigator's design
  folder as in v6.
  The synthetic database bundle (validation/fixtures/db_bundle_v7_synthetic/) matches none of these names and carries
  NCT99 placeholders only, which the v2 checker allows.
  Content, any text file: the format markers of the private v7 import files ("format": "mu7_import_units" or
  "mu7_import_training_units").
  Required .gitignore entries: the v7 private names.
--packets FILE (repeatable): audits a PRIVATE import file before it is sent to the database, with the rules of the
  database packet guard (MU7-G14 to MU7-G19): key allow lists, schema_version 7.0, the registry link of the unit's own
  trial only, no notice on a FORMAL packet. Registry text that names another registry or another trial is ACCEPTED
  (relaxed rule R1, investigator decision 24) and only counted. NCT IDs are never printed.
--negative-control: builds a scratch tree with one planted violation of each v7 kind and one planted packet error, and
  exits 0 only when the checker flags every one of them (the checker is shown to detect what it claims to detect).

Usage (repository root):
    python tools/check_public_repo_leakage_v7.py [--tree] [--root DIR] [--private-sample FILE ...]
    python tools/check_public_repo_leakage_v7.py --packets data_private/MU7_IMPORT_UNITS_v7_PROPOSED_PRIVATE.json
    python tools/check_public_repo_leakage_v7.py --negative-control
"""
from __future__ import annotations

import importlib.util
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
L6 = L5 = L4 = L3 = L = None


def _load_earlier_checkers() -> None:
    """The tree scan runs through the v6 checker (and through it v5, v4, v3 and v2), imported from this folder. The
    packet audit (--packets) does not need them and runs on its own."""
    global L6, L5, L4, L3, L
    if L6 is None:
        spec = importlib.util.spec_from_file_location("leak_v6", HERE / "check_public_repo_leakage_v6.py")
        L6 = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(L6)
        L5, L4, L3, L = L6.L5, L6.L4, L6.L3, L6.L

V7_FORBIDDEN_NAMES = [
    "MAPPING_UNITS_v7*", "FROZEN_ASSIGNMENTS_v7*", "QUEUE_ORDER_v7*", "freeze_manifest_v7*", "MU7_IMPORT_*", "FRAMES_v7*",
    "PROVENANCE_AUDIT_v7*", "CALIBRATION_TRIALS_AUDIT_v7*", "TRAINING_UNITS_v7*", "WORKED_EXAMPLES_v7*",
    "UNIT_PROBABILITIES_ONE_PER_TRIAL_v7*", "PATTERN_GROUP_PROBABILITIES_v7*", "*_PRIVATE.*", "*_PRIVATE_*",
    "CLAUDE_CODE_SCIENTIFIC_CONTRACT_v7*", "claude_code_private_staging_v7*", "bundle_v7*", "performance_results_v7*",
    "dry_run_private_v7_results*",
    # the design scripts stay in the investigator's design folder, as in v6 (they name the worked-example trials)
    "v7_common.py", "00_verify_inputs_v7*", "00b_extract_v52_objects_v7*", "01_build_unit_frames_v7*",
    "02_allocation_projection_v7*", "03_draw_units_v7*", "04_overlap_alternative_mc_v7*", "05_training_units_v7*",
    "06_build_unit_packets_v7*", "07_db_tests_v7*", "08_build_docs_v7*", "09_package_handoff_v7*", "run_all_v7.sh",
]
# the public placeholder README of data_private/ (a v6 file that says what belongs there) matches *_PRIVATE.*
V7_NAME_EXCEPTIONS = {"data_private/README_DATA_PRIVATE.md"}
V7_CONTENT_RULES = [
    ("format marker of a private v7 import file",
     re.compile(r"\"format\"\s*:\s*\"mu7_import_(?:units|training_units)\""), "all"),
]
V7_REQUIRED_GITIGNORE = ["MAPPING_UNITS_v7*", "FROZEN_ASSIGNMENTS_v7*", "QUEUE_ORDER_v7*", "freeze_manifest_v7*",
                         "MU7_IMPORT_*", "*_PRIVATE.*", "claude_code_private_staging_v7*", "bundle_v7*"]
SELF_EXEMPT_V7 = {"tools/check_public_repo_leakage_v7.py"}

TOP = {"schema_version", "unit", "trial", "notices"}
UNIT = {"unit_id", "mode", "family", "category", "unit_role", "mapping_code", "mapping_label", "assignment_code",
        "assignment_status", "display_text", "display_decision", "parent_row_code", "parent_row_label", "display_note"}
TRIAL = {"nct_id", "registry_url", "brief_title", "official_title", "conditions_registered", "condition_mesh_headings",
         "brief_summary", "detailed_description", "interventions", "eligibility_age_range"}
IMPORT_KEYS = {"unit_id", "mode", "record_category", "family", "category", "unit_role", "mapping_code", "assignment_code",
               "assignment_status", "parent_row_code", "packet", "design", "assignment"}
NCT = re.compile(r"\bNCT\d{8}\b")


# Repository change (civicsample-verify, 2026-10-23, review thread on PR #8): the audit also mirrors guards MU7-G14
# (a unit block must exist), MU7-G17 (the unit block equals the import row), MU7-G18 (canonical display texts, from the
# vocabulary contract that the supplied suite checks against the database helpers) and MU7-G19 (the PILOT notice),
# so it no longer certifies files the database is certain to refuse.
VOCABULARY = HERE.parent / "tests" / "handoff" / "fixtures" / "v7" / "VOCABULARY_CONTRACT_v7.json"
ROW_FIELDS = ("unit_id", "mode", "family", "category", "unit_role", "mapping_code", "assignment_code",
              "assignment_status", "parent_row_code")
PILOT_NOTICE = "SYNTHETIC UNIT: excluded from every statistic"


def _unit_block_violations(u: dict, p: dict, voc: dict, where: str) -> list:
    v = []
    ub = p.get("unit")
    if not isinstance(ub, dict):
        return [("PACKET_UNIT_FIELDS", where, "the packet has no unit block (MU7-G14)")]
    if any(ub.get(k) != u.get(k) for k in ROW_FIELDS):
        v.append(("PACKET_UNIT_FIELDS", where, "the unit block must equal the import row (MU7-G17)"))
    fam, cat, code, parent = u.get("family"), u.get("category"), u.get("assignment_code"), u.get("parent_row_code")
    text_key = "AREA|IN_AREA" if fam == "AREA" else "ROW|IN_ROW" if fam == "ROW" else f"SG|{code}"
    if ub.get("mapping_label") != voc["mapping_labels"].get(f"{fam}|{cat}") or ub.get("display_text") != voc["display_texts"].get(text_key):
        v.append(("PACKET_DISPLAY_TEXT", where, "mapping label or assignment text is not canonical (MU7-G18)"))
    if fam == "SG":
        row = (parent or "").replace("FIG2_ROW_", "")
        if ub.get("display_decision") != voc["display_decisions"].get(cat) or ub.get("parent_row_label") != voc["row_labels"].get(row):
            v.append(("PACKET_DISPLAY_TEXT", where, "a subgroup unit restates its parent row and decision canonically (MU7-G18)"))
    elif "display_decision" in ub or "parent_row_label" in ub:
        v.append(("PACKET_DISPLAY_TEXT", where, "only subgroup units carry a decision and a parent row (MU7-G18)"))
    if "display_note" in ub and not (fam == "AREA" and cat == "MENTAL_HEALTH" and ub["display_note"] == voc["mental_health_note"]):
        v.append(("PACKET_DISPLAY_TEXT", where, "a display note only on a Mental health unit, canonical wording (MU7-G18)"))
    if u.get("mode") == "PILOT" and PILOT_NOTICE not in (p.get("notices") or []):
        v.append(("PACKET_NOTICE", where, "a PILOT packet carries the synthetic notice (MU7-G19)"))
    return v


def audit_packets(path: Path, vocabulary: Path = VOCABULARY) -> tuple[list, dict]:
    """Rules of the database packet guard, applied before import. Returns (violations, counts); never prints IDs."""
    obj = json.loads(path.read_text(encoding="utf-8"))
    v, counts = [], {"units": 0, "registry_text_names_another_trial": 0, "registry_text_names_clinicaltrials_gov": 0}
    try:
        voc = json.loads(vocabulary.read_text(encoding="utf-8"))
        assert voc.get("format") == "mu7_vocabulary_contract"
    except (OSError, ValueError, AssertionError):
        return [("VOCABULARY_UNAVAILABLE", str(vocabulary.name), "the vocabulary contract is required for MU7-G18")], counts
    for i, u in enumerate(obj.get("units", [])):
        u = u.get("import", u)
        counts["units"] += 1
        where = f"unit {i + 1} ({u.get('unit_id', '?')})"
        if set(u) - IMPORT_KEYS:
            v.append(("PACKET_IMPORT_KEY", where, f"keys not accepted by rpc_mu7_import_unit: {sorted(set(u) - IMPORT_KEYS)}"))
        p = u.get("packet", {})
        if set(p) - TOP or p.get("schema_version") != "7.0":
            v.append(("PACKET_TOP_LEVEL", where, "top-level keys or schema_version (MU7-G14)"))
        if set(p.get("unit", {})) - UNIT:
            v.append(("PACKET_UNIT_KEY", where, "unit key not on the allow list (MU7-G14)"))
        t = p.get("trial", {})
        if set(t) - TRIAL:
            v.append(("PACKET_TRIAL_KEY", where, "trial key not on the allow list (MU7-G15)"))
        nct = t.get("nct_id", "")
        v.extend(_unit_block_violations(u, p, voc, where))
        if u.get("mode") == "FORMAL":
            if not re.fullmatch(r"NCT\d{8}", nct) or t.get("registry_url") != f"https://clinicaltrials.gov/study/{nct}":
                v.append(("PACKET_REGISTRY_LINK", where, "a FORMAL packet links its own trial's record (MU7-G16)"))
            if p.get("notices"):
                v.append(("PACKET_NOTICE", where, "a FORMAL packet carries no notice (MU7-G19)"))
            d = u.get("design", {})
            if d.get("nct_id") != nct:
                v.append(("PACKET_DESIGN_NCT", where, "the design row names another trial than the packet (MU7-G20)"))
        txt = " ".join(str(t.get(k, "")) for k in ("brief_title", "official_title", "brief_summary", "detailed_description"))
        txt += " ".join(str(x.get("description", "")) for x in t.get("interventions", []))
        if set(NCT.findall(txt)) - {nct}:
            counts["registry_text_names_another_trial"] += 1          # accepted as registered (R1)
        if re.search(r"clinicaltrials\.gov", txt, re.I):
            counts["registry_text_names_clinicaltrials_gov"] += 1     # accepted as registered (R1)
    return v, counts


def run_tree(argv: list) -> int:
    _load_earlier_checkers()
    L.FORBIDDEN_NAME_PATTERNS.extend(p for p in V7_FORBIDDEN_NAMES if p not in L.FORBIDDEN_NAME_PATTERNS)
    L.NAME_EXCEPTIONS.update(V7_NAME_EXCEPTIONS)
    L.REQUIRED_GITIGNORE.extend(e for e in V7_REQUIRED_GITIGNORE if e not in L.REQUIRED_GITIGNORE)
    L.CONTENT_RULES.extend(V7_CONTENT_RULES)
    L3.SELF_EXEMPT.update(SELF_EXEMPT_V7)
    rc = L6.main(argv)
    print("v7 checks: names, content markers and .gitignore entries applied through the v2 scan")
    return rc


def negative_control() -> int:
    """Plant one violation of each v7 kind, each in its own scratch tree, and require the checker to flag it.

    Repository change (civicsample-verify, 2026-10-23, review thread on PR #8): the scanner withholds every path and
    value by design, so the control is differential: a planted file is DETECTED when its isolated tree exits 1 and
    reports MORE violations of the expected category than the same tree without it (the planted file is the cause).
    A bare scratch tree is not violation-free, because the earlier checkers expect the full repository (their ignore
    entries, the JavaScript fixture guard), so an exit code alone proves nothing.
    """
    _load_earlier_checkers()
    planted = [("MAPPING_UNITS_v7_PROPOSED_PRIVATE.csv", "unit_id\nMU7-AREA-ONCOLOGY-001\n", "FORBIDDEN_FILE"),
               ("notes/import.json", '{"format": "mu7_import_units", "units": []}\n', "FORBIDDEN_CONTENT"),
               ("docs/link.md", "see https://clinicaltrials.gov/study/" + "NCT" + "01234567\n", "FORBIDDEN_CONTENT")]

    def scan(files: dict) -> tuple[int, set]:
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "tools").mkdir()
            for f in HERE.glob("check_public_repo_leakage*.py"):
                (root / "tools" / f.name).write_text(f.read_text(encoding="utf-8"), encoding="utf-8")
            (root / ".gitignore").write_text("\n".join(V7_REQUIRED_GITIGNORE + L6.V6_REQUIRED_GITIGNORE) + "\n")
            for rel, txt in files.items():
                p = root / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(txt, encoding="utf-8")
            r = subprocess.run([sys.executable, str(root / "tools" / "check_public_repo_leakage_v7.py"), "--root", str(root), "--tree"],
                               capture_output=True, text=True)
            counts = {m.group(1): int(m.group(2)) for m in re.finditer(r"^([A-Z_]+): ([0-9]+) violation", r.stdout, re.M)}
            return r.returncode, counts

    _, baseline = scan({})
    found = {}
    for rel, txt, kind in planted:
        rc, counts = scan({rel: txt})
        found[f"{rel} ({kind})"] = rc == 1 and counts.get(kind, 0) > baseline.get(kind, 0)
    with tempfile.TemporaryDirectory() as d:
        pk = Path(d) / "pk.json"
        bad_link = {"unit_id": "MU7-AREA-ONCOLOGY-001", "mode": "FORMAL", "packet": {
            "schema_version": "7.0", "unit": {}, "trial": {"nct_id": "NCT" + "99000101", "registry_url": "https://clinicaltrials.gov/study/NCT" + "99000999"},
            "notices": []}, "design": {"nct_id": "NCT" + "99000101"}}
        pk.write_text(json.dumps({"units": [bad_link]}))
        pv, _ = audit_packets(pk)
        found["planted packet with a foreign registry link"] = any(k == "PACKET_REGISTRY_LINK" for k, _, _ in pv)
        found["planted packet with an empty unit block"] = any(k == "PACKET_UNIT_FIELDS" for k, _, _ in pv)
    for k, ok in found.items():
        print(f"negative control: {'DETECTED' if ok else 'MISSED'}\t{k}")
    print(f"negative control: {sum(found.values())} of {len(found)} checks hold")
    return 0 if all(found.values()) else 1


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--negative-control" in argv:
        return negative_control()
    packets = []
    while "--packets" in argv:
        i = argv.index("--packets")
        packets.append(Path(argv[i + 1]))
        del argv[i:i + 2]
    if packets:
        bad = 0
        for p in packets:
            v, c = audit_packets(p)
            for kind, where, why in v:
                print(f"{kind}\t{where}\t{why}")
            print(f"packet audit {p.name}: {c['units']} units, {len(v)} violation(s); accepted as registered (R1): "
                  f"{c['registry_text_names_another_trial']} units whose text names another trial, "
                  f"{c['registry_text_names_clinicaltrials_gov']} whose text names clinicaltrials.gov")
            bad += len(v)
        return 1 if bad else 0
    return run_tree(argv)


if __name__ == "__main__":
    sys.exit(main())
