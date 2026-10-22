#!/usr/bin/env python3
"""
tools/check_public_repo_leakage_v4.py  (handoff v4)

Runs every check of tools/check_public_repo_leakage_v3.py, and through it every check of
tools/check_public_repo_leakage.py (v2), with the v4 additions below. Both earlier checkers are
adapted for repository/index scanning from the same folder. Exit 0 when clean, 1 when any violation is found.

v4 additions
  Names (never committed): the v4 provenance audit, held-out sample, extension option, development
  and calibration cases, frozen prediction files, freeze manifest, Module B sample, the Workstream B
  OQ policy ledger, the private v4 design documents (SAMPLING_DESIGN_v4, SAMPLING_PRECISION_MEMO_v4,
  PROVENANCE_AUDIT_v4_SUMMARY, FREEZE_MANIFEST_v4), every unit-level table of review_design_v4/tables,
  the v4 design logs, the private import dry run and the v1.2 PROVISIONAL decision files.
  Content, any text file: real-format v4 identifiers (numeric HO4/HO4R case IDs, DEV4-nnnn, CAL4-nn,
  MB4-Tn-nn) and frame-unit identifiers that carry a MeSH UI or an NCT ID (DU::D..., OU::D...,
  TU::NCT...). Synthetic identifiers carry TESTFX (HO4-TESTFX-0001, MB4-T-TESTFX-001) and never match.
  Content, data-like files: the headers of the v4 private files (held-out sample, development cases,
  provenance audit, Module B sample).
  Required .gitignore entries: the v4 private names.
  Optional deep check (--private-sample FILE, repeatable): reads private sample files on the
  investigator's machine and flags any scanned file that contains one of their MeSH descriptor UIs,
  NCT IDs or descriptor names. Hits are reported as counts per file, never by value.

Usage (repository root):
    python tools/check_public_repo_leakage_v4.py                     # files git tracks or would add
    python tools/check_public_repo_leakage_v4.py --tree              # public source and indexed blobs
    python tools/check_public_repo_leakage_v4.py --root DIR --tree   # scan another folder (package checks)
    python tools/check_public_repo_leakage_v4.py --root DIR --tree \\
        --private-sample /path/to/REVIEW_SAMPLE_v4_HELDOUT_PROPOSED.csv   # plus the deep check
"""
from __future__ import annotations

import csv
import importlib.util
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("leak_v3", HERE / "check_public_repo_leakage_v3.py")
L3 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(L3)
L = L3.L                                   # the v2 module that the v3 checker configures

V4_FORBIDDEN_NAMES = [
    "PROVENANCE_AUDIT*", "REVIEW_SAMPLE_v4*", "DEVELOPMENT_CASES*", "FROZEN_PREDICTIONS*", "FREEZE_MANIFEST_v4*",
    "freeze_manifest_v4*", "MODULE_B_SAMPLE*", "development_cases_OQ_policies*", "SAMPLING_DESIGN_v4*",
    "SAMPLING_PRECISION_MEMO_v4*", "allocation_candidates_choice_v4*", "allocation_v4_adopted*", "change_coverage_v4*",
    "design_diagnostics_v4*", "freeze_items_v4*", "largest_v11_changes_provenance*", "module_b_decision_aid_v4*",
    "module_b_design_v4*", "precision_candidates_v4*", "precision_kappa_v4*", "precision_per_area_feasibility_v4*",
    "precision_summary_v4*", "provenance_exclusions_by_reason*", "provenance_named_descriptor_sources*",
    "provenance_pool_by_cell*", "sampling_design_v4_composition*", "sampling_design_v4_strata*",
    "01_provenance_audit_v4*", "02_precision_simulation_v4*", "03_draw_heldout_sample_v4*", "04_module_b_v4*",
    "07_db_import_dryrun_v4*", "DECISION_FILE_v1.2*", "TRIAL_LEVEL_DECISIONS_v1.2*", "clinical_review_results_block_v4.md",
    "performance_results_v4*",
]
V4_NAME_EXCEPTIONS = {
    "validation/fixtures/synthetic_v4_independent_judgments.csv",
    "validation/fixtures/synthetic_v4_adjudicated_reference.csv",
    "validation/fixtures/synthetic_v4_frozen_predictions.csv",
    "validation/fixtures/synthetic_v4_bundle.manifest.json",
}
V4_CONTENT_RULES = [
    ("real-format v4 held-out case ID (numeric HO4/HO4R IDs)", re.compile(r"\bHO4R?-\d{3}\b"), "all"),
    ("real-format v4 development or calibration ID (DEV4-nnnn, CAL4-nn)", re.compile(r"\b(?:DEV4-\d{4}|CAL4-\d{2})\b"), "all"),
    ("real-format Module B trial unit ID (MB4-Tn-nn)", re.compile(r"\bMB4-T\d+-\d{2}\b"), "all"),
    ("frame-unit ID with a real MeSH UI or NCT ID", re.compile(r"\b(?:DU|OU)::D\d{6,9}::|\bTU::NCT\d{8}"), "all"),
    ("v4 held-out sample header (case_id_v4 with selection_stratum_v4)",
     re.compile(r"^[^\n]*case_id_v4[^\n]*selection_stratum_v4", re.M), "data"),
    ("v4 development-case header (dev_case_id_v4 with primary_exclusion_reason)",
     re.compile(r"^[^\n]*dev_case_id_v4[^\n]*primary_exclusion_reason", re.M), "data"),
    ("v4 provenance-audit header (frame_unit_id_v3 with f_ontology_text_named)",
     re.compile(r"^[^\n]*frame_unit_id_v3[^\n]*f_ontology_text_named", re.M), "data"),
    ("v4 Module B sample header (module_b_unit_id with pipeline_compatibility_status)",
     re.compile(r"^[^\n]*module_b_unit_id[^\n]*pipeline_compatibility_status", re.M), "data"),
]
V4_REQUIRED_GITIGNORE = ["PROVENANCE_AUDIT*", "REVIEW_SAMPLE_v4*", "DEVELOPMENT_CASES*", "FROZEN_PREDICTIONS*",
                         "FREEZE_MANIFEST_v4*", "freeze_manifest_v4*", "MODULE_B_SAMPLE*", "SAMPLING_DESIGN_v4*",
                         "SAMPLING_PRECISION_MEMO_v4*"]
SELF_EXEMPT_V4 = {"tools/check_public_repo_leakage_v4.py"}


def _deep_terms(paths):
    """MeSH UIs, NCT IDs and descriptor names from private sample files (kept in memory only)."""
    uis, ncts, names = set(), set(), set()
    for p in paths:
        with open(p, newline="", encoding="utf-8") as fh:
            for r in csv.DictReader(fh):
                if (r.get("descriptor_ui") or "").strip():
                    uis.add(r["descriptor_ui"].strip())
                if (r.get("nct_id") or "").strip():
                    ncts.add(r["nct_id"].strip())
                if len((r.get("descriptor_name") or "").strip()) >= 4:
                    names.add(r["descriptor_name"].strip())
    return uis, ncts, names


def deep_check(files, root: Path, paths) -> list:
    """Counts, per scanned file, the private descriptor UIs, NCT IDs and descriptor names it contains."""
    uis, ncts, names = _deep_terms(paths)
    ui_rx = [re.compile(r"\b" + re.escape(u) + r"\b") for u in sorted(uis)]
    name_rx = [re.compile(r"(?<![A-Za-z0-9])" + re.escape(n) + r"(?![A-Za-z0-9])") for n in sorted(names)]
    v = []
    for f, raw, error in L.source_entries(files):
        if error or Path(f).suffix.lower() in L.BINARY_SUFFIXES | L.DATA_CONTAINER_SUFFIXES:
            continue
        text = raw.decode("utf-8", errors="ignore")
        n_ui = sum(1 for rx in ui_rx if rx.search(text))
        n_nct = sum(1 for c in ncts if c in text)
        n_name = sum(1 for rx in name_rx if rx.search(text))
        if n_ui or n_nct or n_name:
            v.append(("PRIVATE_SAMPLE_TERM", f, f"{n_ui} descriptor UIs, {n_nct} NCT IDs and {n_name} descriptor names "
                                               "from the private sample files (values not printed)"))
    return v


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    private = []
    while "--private-sample" in argv:
        i = argv.index("--private-sample")
        private.append(argv[i + 1])
        del argv[i:i + 2]
    L.FORBIDDEN_NAME_PATTERNS.extend(p for p in V4_FORBIDDEN_NAMES if p not in L.FORBIDDEN_NAME_PATTERNS)
    L.NAME_EXCEPTIONS.update(V4_NAME_EXCEPTIONS)
    L.REQUIRED_GITIGNORE.extend(e for e in V4_REQUIRED_GITIGNORE if e not in L.REQUIRED_GITIGNORE)
    L.CONTENT_RULES.extend(V4_CONTENT_RULES)
    L3.SELF_EXEMPT.update(SELF_EXEMPT_V4)
    rc = L3.main(argv)                      # applies the v3 additions, sets the root, runs the v2 scan
    if not private:
        return rc
    files = [f for f in L.candidate_files("--tree" in argv) if f not in L3.SELF_EXEMPT]
    try:
        v = deep_check(files, L.ROOT, private)
    except (OSError, UnicodeError, csv.Error):
        v = [("PRIVATE_SAMPLE_UNREADABLE", "", "")]
    L.report(v)
    print(f"deep check against {len(private)} private sample file(s), {len(files)} files: {len(v)} violation(s)")
    return 1 if (rc or v) else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, UnicodeError, ValueError, IndexError):
        print("SCAN_FAILED: 1 violation(s); input paths and values withheld")
        sys.exit(1)
