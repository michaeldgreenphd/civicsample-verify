#!/usr/bin/env python3
"""
tools/check_public_repo_leakage_v5.py  (handoff v5)

Runs every check of tools/check_public_repo_leakage_v4.py, and through it every check of the v3 and v2
checkers, with the v5 additions below. The earlier checkers are adapted for repository/index scanning from
the same folder. Exit 0 when clean, 1 when any violation is found.

v5 additions
  Names (never committed): the v5 sample, frozen labels, calibration trials, freeze manifest and frame;
  the private v5 design documents (SAMPLING_DESIGN_v5, REVIEW_DESIGN_v5_SUMMARY, numbers_trace_v5); every
  table and log of review_design_v5; the private v5 scripts; real v5 export bundles and results.
  Content, any text file: real-format v5 identifiers (TLV5-nnn, CAL5-nn). Synthetic identifiers never match:
  pilot cases carry SYN- (SYN-TLV5-001), formal test cases carry TESTFX (TLV5-TESTFX-0001, CAL5-TESTFX-01).
  Content, data-like files: the headers of the v5 private files.
  Required .gitignore entries: the v5 private names.
  Optional deep check (--private-sample FILE, repeatable): reads the private v5 files on the investigator's
  machine (REVIEW_SAMPLE_v5_PROPOSED.csv, FROZEN_LABELS_v5_PROPOSED.csv, CALIBRATION_TRIALS_v5_PROPOSED.csv and,
  for v5.1, tables/worked_examples_v5_exclusion_check.csv) and flags any scanned file or indexed blob that
  contains one of their NCT IDs or case IDs. Training case IDs (EX5-01 to EX5-03) are generic labels used by
  the public tests and documents, so only the NCT IDs of the worked examples are checked. Hits are counted,
  never printed.
v5.1 additions (migration 0005): the private worked-example files and scripts are forbidden names and required
  .gitignore entries (WORKED_EXAMPLES_v5*, worked_examples_v5*, 06_worked_examples_v5*, 07_db_training_dryrun_v5*,
  numbers_trace_worked_examples_v5*, run_all_v5_1.sh).

Usage (repository root):
    python tools/check_public_repo_leakage_v5.py                     # files git tracks or would add
    python tools/check_public_repo_leakage_v5.py --tree              # public source and indexed blobs
    python tools/check_public_repo_leakage_v5.py --root DIR --tree --private-sample /path/to/REVIEW_SAMPLE_v5_PROPOSED.csv
"""
from __future__ import annotations

import csv
import importlib.util
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("leak_v4", HERE / "check_public_repo_leakage_v4.py")
L4 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(L4)
L3 = L4.L3
L = L4.L

V5_FORBIDDEN_NAMES = [
    "REVIEW_SAMPLE_v5*", "FROZEN_LABELS_v5*", "CALIBRATION_TRIALS_v5*", "freeze_manifest_v5*", "FREEZE_MANIFEST_v5*",
    "FRAME_v5*", "SAMPLING_DESIGN_v5*", "REVIEW_DESIGN_v5_SUMMARY*", "numbers_trace_v5*", "README_review_design_v5*",
    "allocation_candidates_v5*", "frame_area_summary_v5*", "frame_choice_comparison_v5*", "frame_domains_v5*",
    "frame_figure2_rows_v5*", "frame_strata_v5*", "precision_projection_v5*", "sample_composition_v5*",
    "sampling_design_v5_strata*", "v5_model_flags_check*", "00_verify_v5_model_flags*", "01_build_frame_v5*",
    "02_precision_simulation_v5*", "03_draw_sample_v5*", "04_db_import_dryrun_v5*", "05_build_docs_v5*", "v5_design.py",
    "v5_common.py", "run_all_v5.sh", "independent_judgments_v5*", "adjudicated_reference_v5*", "frozen_labels_v5*",
    "bundle_v5*.manifest.json", "performance_results_v5*", "performance_estimates_v5*", "clinical_review_results_block_v5*",
    # v5.1 (worked training examples: real NCT identifiers and the investigators-only label comparison)
    "WORKED_EXAMPLES_v5*", "worked_examples_v5*", "06_worked_examples_v5*", "07_db_training_dryrun_v5*",
    "numbers_trace_worked_examples_v5*", "run_all_v5_1.sh",
]
V5_NAME_EXCEPTIONS = {
    "analysis/fixtures/synthetic_v5_independent_judgments.csv",
    "analysis/fixtures/synthetic_v5_adjudicated_reference.csv",
    "analysis/fixtures/synthetic_v5_frozen_labels.csv",
    "analysis/fixtures/synthetic_v5_bundle.manifest.json",
}
V5_CONTENT_RULES = [
    ("real-format v5 formal case ID (TLV5-nnn)", re.compile(r"(?<!SYN-)\bTLV5-\d{3}\b"), "all"),
    ("real-format v5 calibration case ID (CAL5-nn)", re.compile(r"\bCAL5-\d{2}\b"), "all"),
    ("v5 sample header (case_id_v5 with stratum_v5)", re.compile(r"^[^\n]*case_id_v5[^\n]*stratum_v5", re.M), "data"),
    ("v5 frozen-label header (label_primary with label_primary_source)",
     re.compile(r"^[^\n]*label_primary[^\n]*label_primary_source", re.M), "data"),
    ("v5 calibration header (cal_case_id_v5)", re.compile(r"^[^\n]*cal_case_id_v5", re.M), "data"),
    ("v5 frame header (stratum_fig3 with stratum_58006)", re.compile(r"^[^\n]*stratum_fig3[^\n]*stratum_58006", re.M), "data"),
]
V5_REQUIRED_GITIGNORE = ["REVIEW_SAMPLE_v5*", "FROZEN_LABELS_v5*", "CALIBRATION_TRIALS_v5*", "freeze_manifest_v5*", "FRAME_v5*",
                         "SAMPLING_DESIGN_v5*", "numbers_trace_v5*", "independent_judgments_v5*", "adjudicated_reference_v5*",
                         "frozen_labels_v5*", "WORKED_EXAMPLES_v5*", "worked_examples_v5*"]
SELF_EXEMPT_V5 = {"tools/check_public_repo_leakage_v5.py"}


def _deep_terms(paths):
    """NCT IDs and case IDs from the private v5 files (kept in memory only)."""
    ncts, ids = set(), set()
    for p in paths:
        with open(p, newline="", encoding="utf-8") as fh:
            for r in csv.DictReader(fh):
                for k in ("nct_id",):
                    if (r.get(k) or "").strip():
                        ncts.add(r[k].strip())
                for k in ("case_id_v5", "case_id", "cal_case_id_v5"):
                    v = (r.get(k) or "").strip()
                    if v and not v.startswith("EX5-"):   # training case IDs are generic labels (see the docstring)
                        ids.add(v)
    return ncts, ids


def deep_check(files, root: Path, paths) -> list:
    """Counts, per scanned file or indexed blob, the private v5 NCT IDs and case IDs it contains."""
    ncts, ids = _deep_terms(paths)
    id_rx = [re.compile(r"(?<![A-Za-z0-9-])" + re.escape(i) + r"(?![A-Za-z0-9])") for i in sorted(ids)]
    v = []
    for f, raw, error in L.source_entries(files):
        if error or Path(f).suffix.lower() in L.BINARY_SUFFIXES | L.DATA_CONTAINER_SUFFIXES:
            continue
        text = raw.decode("utf-8", errors="ignore")
        n_nct = sum(1 for c in ncts if c in text)
        n_id = sum(1 for rx in id_rx if rx.search(text))
        if n_nct or n_id:
            v.append(("PRIVATE_SAMPLE_TERM", f, f"{n_nct} NCT IDs and {n_id} case IDs from the private v5 files (values not printed)"))
    return v


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    private = []
    while "--private-sample" in argv:
        i = argv.index("--private-sample")
        private.append(argv[i + 1])
        del argv[i:i + 2]
    L.FORBIDDEN_NAME_PATTERNS.extend(p for p in V5_FORBIDDEN_NAMES if p not in L.FORBIDDEN_NAME_PATTERNS)
    L.NAME_EXCEPTIONS.update(V5_NAME_EXCEPTIONS)
    L.REQUIRED_GITIGNORE.extend(e for e in V5_REQUIRED_GITIGNORE if e not in L.REQUIRED_GITIGNORE)
    L.CONTENT_RULES.extend(V5_CONTENT_RULES)
    L3.SELF_EXEMPT.update(SELF_EXEMPT_V5)
    rc = L4.main(argv)                      # applies the v4 and v3 additions, sets the root, runs the v2 scan
    if not private:
        return rc
    files = [f for f in L.candidate_files("--tree" in argv) if f not in L3.SELF_EXEMPT]
    try:
        v = deep_check(files, L.ROOT, private)
    except (OSError, UnicodeError, csv.Error):
        v = [("PRIVATE_SAMPLE_UNREADABLE", "", "")]
    L.report(v)
    print(f"v5 deep check against {len(private)} private file(s), {len(files)} files: {len(v)} violation(s)")
    return 1 if (rc or v) else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, UnicodeError, ValueError, IndexError):
        print("SCAN_FAILED: 1 violation(s); input paths and values withheld")
        sys.exit(1)
