#!/usr/bin/env python3
"""
tools/check_public_repo_leakage_v3.py  (handoff v3)

Runs every check of tools/check_public_repo_leakage.py (v2 rule lists preserved, repository integration adapted from the same
folder) with the v3 additions below. Exit 0 when clean, 1 when any violation is found.

v3 additions
  Names (never committed): the v3 proposed sample, reserve and frame (already covered by the v2
  REVIEW_SAMPLE*.csv and SAMPLING_FRAME*.csv patterns), the Module B trial sample and row file, the
  current-sample unit file, Workstream 1 unit-level files (high-risk cases, unit roles, worked-example
  consistency, pair changes, trial-area change drivers), the private design documents that name
  sampled units (CURRENT_SAMPLE_AUDIT_v3, SAMPLING_PRECISION_MEMO_v3, REVIEW_UNIT_SPECIFICATION_v3,
  REVIEW_RUBRIC_v3 design notes), the private transfer list, and the compatibility status export.
  Content, any text file: the v3 PROVISIONAL assessment labels that would reveal AI judgements of
  specific units (POSSIBLE_NEW_ERROR, IMPROVEMENT_FACE_VALID and similar), and the v3 sample-file
  header (case_id_v3 with selection_stratum).
  Required .gitignore entries: the v3 private names.

Usage (repository root):
    python tools/check_public_repo_leakage_v3.py              # files git tracks or would add
    python tools/check_public_repo_leakage_v3.py --tree       # public source and indexed blobs
    python tools/check_public_repo_leakage_v3.py --root DIR --tree   # scan another folder (package checks)
"""
from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("leak_v2", HERE / "check_public_repo_leakage.py")
L = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(L)

V3_FORBIDDEN_NAMES = [
    "MODULE_B_TRIAL_SAMPLE*", "module_b_row_units*", "current_sample_unit_categories*",
    "high_risk_case_assessment*", "review_sample_unit_roles*", "worked_example_consistency*",
    "descriptor_pair_changes*", "trial_area_changes_long*", "area_change_drivers_by_descriptor*",
    "area_change_examples*", "stage_a_only_changed_pairs*", "v1_1_escalations*", "unchallenged_units*",
    "CURRENT_SAMPLE_AUDIT*", "SAMPLING_PRECISION_MEMO_v3*", "REVIEW_UNIT_SPECIFICATION_v3*",
    "REVIEW_RUBRIC_v3.md", "PRIVATE_TRANSFER_LIST*", "compat_row_status*", "high_risk_group_coverage*",
    "allocation_alternatives_v3*", "sampling_design_v3_strata*", "sampling_design_v3_summary*",
]
V3_NAME_EXCEPTIONS = {
    "validation/fixtures/synthetic_v3_analysis_export.csv",
    "validation/fixtures/synthetic_v3_analysis_export.manifest.json",
}
V3_CONTENT_RULES = [
    ("Workstream 1 PROVISIONAL unit assessment label",
     re.compile(r"\b(POSSIBLE_NEW_ERROR(?:_REVERTED_IN_V1_1)?|IMPROVEMENT_FACE_VALID|IMPROVEMENT_IN_V1_0_REVERTED_IN_V1_1|"
                r"POLICY_DEPENDENT|CONTEXT_DEPENDENT_BOTH_RISK|NO_CHANGE_FACE_VALID|NO_CHANGE_SHARED_RISK)\b"), "all"),
    ("v3 sample-file header (case_id_v3 with selection_stratum)",
     re.compile(r"^[^\n]*case_id_v3[^\n]*selection_stratum", re.M), "data"),
    ("PROVISIONAL assessment column", re.compile(r"high_risk_assessment_PROVISIONAL|possible_error_PROVISIONAL"), "all"),
]
V3_REQUIRED_GITIGNORE = ["MODULE_B_TRIAL_SAMPLE*", "module_b_row_units*", "current_sample_unit_categories*",
                         "high_risk_case_assessment*", "PRIVATE_TRANSFER_LIST*"]

# The checker itself names the patterns it forbids; exempt its own source and the v2 source.
SELF_EXEMPT = {"tools/check_public_repo_leakage_v3.py", "tools/check_public_repo_leakage.py"}


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--root" in argv:
        i = argv.index("--root")
        L.ROOT = Path(argv[i + 1]).resolve()
        del argv[i:i + 2]
    L.FORBIDDEN_NAME_PATTERNS.extend(p for p in V3_FORBIDDEN_NAMES if p not in L.FORBIDDEN_NAME_PATTERNS)
    L.NAME_EXCEPTIONS.update(V3_NAME_EXCEPTIONS)
    L.REQUIRED_GITIGNORE.extend(e for e in V3_REQUIRED_GITIGNORE if e not in L.REQUIRED_GITIGNORE)
    # Only the checker pattern definitions are exempt; paths and indexed blobs remain scanned.
    L.CONTENT_EXCEPTIONS.update(SELF_EXEMPT)
    L.CONTENT_RULES.extend(V3_CONTENT_RULES)
    return L.main(argv)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, UnicodeError, ValueError, IndexError):
        print("SCAN_FAILED: 1 violation(s); input paths and values withheld")
        sys.exit(1)
