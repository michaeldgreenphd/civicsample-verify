#!/usr/bin/env python3
"""
tools/check_public_repo_leakage_v6.py  (handoff v6, the confirm design)

Runs every check of tools/check_public_repo_leakage_v5.py, and through it every check of the v4, v3 and v2 checkers,
with the v6 additions below. The earlier checkers are imported unchanged from the same folder. Exit 0 when clean,
1 when any violation is found.

Why the confirm design still needs a leakage check: in design v6 the reviewers see OUR labels inside the app, but the
public repository must still carry no study data. The frozen labels, the sample, the calibration and worked-example
trials (real NCT identifiers), the private packets with registry text, and the design tables stay on the
investigator's machine; the app imports them from data_private/ only.

v6 additions
  Names (never committed): FROZEN_LABELS_v6*, CALIBRATION_TRIALS_v6*, freeze_manifest_v6*, worked examples v6
  (WORKED_EXAMPLES_v6*, worked_examples_v6*), the private packets (PACKETS_v6*), the private design notes and tables
  (SAMPLING_NOTE_v6*, registry_checks_v6*, frozen_labels_v6_composition*, numbers_trace_*v6*), the private v6
  scripts, real v6 export bundles and results, the private staging archive.
  Content, any text file: a ClinicalTrials.gov record link of a real-format NCT identifier
  (clinicaltrials.gov/study/NCT and 8 digits, except the synthetic NCT99 range of the v2 checker; synthetic packets
  use SYN-NCT identifiers and carry no link), and the format markers of the private JSON files ("format":
  "tlv6_import_packets" or "tlv6_training_examples").
  Content, data-like files: the header of the private v6 frozen-label file (displayed_item_code with row_sha256; the
  public export format has no row_sha256, and the v5 rule on label_primary with label_primary_source also applies).
  Required .gitignore entries: the v6 private names.
  AI consistency run (investigator addition of 2026-10-22): the private kit (claude_code_ai_consistency_kit_v1.zip,
  installed under data_private/ai_consistency_kit/) and its outputs (data_private/ai_runs/) are investigators-only.
  Any file under data_private/ai_runs/, data_private/ai_consistency_kit/ or an ai_runs/ folder anywhere, the kit
  archive itself and its README_KIT are violations; an Anthropic API key in any text file is a violation; .gitignore
  must hold .env, ai_runs/ and claude_code_ai_consistency_kit*.
  Optional deep check (--private-sample FILE, repeatable; CSV, or JSON read at any depth): reads the private files on
  the investigator's or the developer's machine (REVIEW_SAMPLE_v5_PROPOSED.csv, FROZEN_LABELS_v6_PROPOSED.csv,
  CALIBRATION_TRIALS_v6_PROPOSED.csv, worked_examples_v6.json or tables/worked_examples_v6_exclusion_check_PRIVATE.csv)
  and flags any scanned file that contains one of their NCT IDs or case IDs. Training case IDs (EX5-nn, EX6-nn) are generic labels used by the public tests and documents, so only the
  NCT IDs of the worked examples are checked. Hits are counted, never printed.

Usage (repository root):
    python tools/check_public_repo_leakage_v6.py                     # files git tracks or would add
    python tools/check_public_repo_leakage_v6.py --tree              # every file under the root
    python tools/check_public_repo_leakage_v6.py --root DIR --tree --private-sample /path/to/FROZEN_LABELS_v6_PROPOSED.csv
"""
from __future__ import annotations

import csv
import importlib.util
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("leak_v5", HERE / "check_public_repo_leakage_v5.py")
L5 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(L5)
L4, L3, L = L5.L4, L5.L3, L5.L

V6_FORBIDDEN_NAMES = [
    "FROZEN_LABELS_v6*", "CALIBRATION_TRIALS_v6*", "freeze_manifest_v6*", "FREEZE_MANIFEST_v6*", "WORKED_EXAMPLES_v6*",
    "worked_examples_v6*", "PACKETS_v6*", "SAMPLING_NOTE_v6*", "registry_checks_v6*", "frozen_labels_v6_composition*",
    "numbers_trace_v6*", "numbers_trace_0*_v6*", "numbers_trace_worked_examples_v6*", "README_review_design_v6*",
    "v6_common.py", "00_registry_checks_v6*", "01_frozen_labels_v6*", "02_worked_examples_v6*", "03_build_packets_v6*",
    "04_db_confirm_dryrun_v6*", "05_build_docs_v6*", "06_package_handoff_v6*", "run_all_v6.sh",
    "independent_judgments_v6*", "adjudicated_reference_v6*", "bundle_v6*.manifest.json", "performance_results_v6*",
    "performance_estimates_v6*", "clinical_review_results_block_v6*", "claude_code_private_staging_v6*",
    # AI consistency run (investigators only): the kit archive and its instruction file
    "claude_code_ai_consistency_kit*", "README_KIT*",
]
V6_FORBIDDEN_DIRS = ["data_private/ai_runs/", "data_private/ai_consistency_kit/", "ai_runs/"]
AI_RUN_PATH = re.compile(r"(^|/)(ai_runs|ai_consistency_kit)/")
V6_NAME_EXCEPTIONS = {
    "validation/fixtures/synthetic_v6_independent_judgments.csv",
    "validation/fixtures/synthetic_v6_adjudicated_reference.csv",
    "validation/fixtures/synthetic_v6_frozen_labels.csv",
    "validation/fixtures/synthetic_v6_bundle.manifest.json",
}
V6_CONTENT_RULES = [
    # NCT99 followed by 6 digits is the synthetic convention of the v2 checker (NCT_RE); the database tests use it
    ("ClinicalTrials.gov record link of a real-format NCT identifier",
     re.compile(r"clinicaltrials\.gov/(?:study|ct2/show)/NCT(?!99)\d{8}", re.I), "all"),
    ("format marker of a private v6 JSON file (packets or worked examples)",
     re.compile(r"\"format\"\s*:\s*\"tlv6_(?:import_packets|training_examples)\""), "all"),
    # the private file FROZEN_LABELS_v6_PROPOSED.csv carries displayed_item_code and row_sha256 in one header; the
    # public export format (v_tlv6_frozen_labels, the synthetic fixture) has displayed_item_code but no row_sha256
    ("v6 frozen-label file header (displayed_item_code with row_sha256)",
     re.compile(r"^[^\n]*row_sha256[^\n]*displayed_item_code|^[^\n]*displayed_item_code[^\n]*row_sha256", re.M), "data"),
    ("Anthropic API key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}"), "all"),
]
V6_REQUIRED_GITIGNORE = ["FROZEN_LABELS_v6*", "CALIBRATION_TRIALS_v6*", "freeze_manifest_v6*", "WORKED_EXAMPLES_v6*",
                         "worked_examples_v6*", "PACKETS_v6*", "SAMPLING_NOTE_v6*", "independent_judgments_v6*",
                         "adjudicated_reference_v6*", "claude_code_private_staging_v6*", ".env", "ai_runs/",
                         "claude_code_ai_consistency_kit*"]
SELF_EXEMPT_V6 = {"tools/check_public_repo_leakage_v6.py"}
GENERIC_ID = re.compile(r"^EX[56]-\d{2}$")


ID_KEYS = ("case_id_v5", "case_id", "cal_case_id_v5")


def _walk_json(o, ncts, ids):
    """Collect nct_id and case-ID values at any depth of a private JSON file (for example worked_examples_v6.json)."""
    if isinstance(o, dict):
        for k, v in o.items():
            if isinstance(v, str) and v.strip():
                if k == "nct_id":
                    ncts.add(v.strip())
                elif k in ID_KEYS and not GENERIC_ID.match(v.strip()):
                    ids.add(v.strip())
            else:
                _walk_json(v, ncts, ids)
    elif isinstance(o, list):
        for v in o:
            _walk_json(v, ncts, ids)


def _deep_terms(paths):
    """NCT IDs and case IDs from the private files, CSV or JSON (kept in memory only; never printed)."""
    ncts, ids = set(), set()
    for p in paths:
        if str(p).lower().endswith(".json"):
            import json
            with open(p, encoding="utf-8") as fh:
                _walk_json(json.load(fh), ncts, ids)
            continue
        with open(p, newline="", encoding="utf-8") as fh:
            for r in csv.DictReader(fh):
                if (r.get("nct_id") or "").strip():
                    ncts.add(r["nct_id"].strip())
                for k in ID_KEYS:
                    v = (r.get(k) or "").strip()
                    if v and not GENERIC_ID.match(v):
                        ids.add(v)
    return ncts, ids


def deep_check(files, root: Path, paths) -> list:
    ncts, ids = _deep_terms(paths)
    id_rx = [re.compile(r"(?<![A-Za-z0-9-])" + re.escape(i) + r"(?![A-Za-z0-9])") for i in sorted(ids)]
    v = []
    for f in files:
        p = root / f
        if p.suffix.lower() in L.BINARY_SUFFIXES or p.suffix.lower() in L.DATA_CONTAINER_SUFFIXES:
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        n_nct = sum(1 for c in ncts if c in text)
        n_id = sum(1 for rx in id_rx if rx.search(text))
        if n_nct or n_id:
            v.append(("PRIVATE_SAMPLE_TERM", f, f"{n_nct} NCT IDs and {n_id} case IDs from the private v6 files (values not printed)"))
    return v


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    private = []
    while "--private-sample" in argv:
        i = argv.index("--private-sample")
        private.append(argv[i + 1])
        del argv[i:i + 2]
    L.FORBIDDEN_NAME_PATTERNS.extend(p for p in V6_FORBIDDEN_NAMES if p not in L.FORBIDDEN_NAME_PATTERNS)
    L.NAME_EXCEPTIONS.update(V6_NAME_EXCEPTIONS)
    L.REQUIRED_GITIGNORE.extend(e for e in V6_REQUIRED_GITIGNORE if e not in L.REQUIRED_GITIGNORE)
    L.CONTENT_RULES.extend(V6_CONTENT_RULES)
    L.FORBIDDEN_DIRS.extend(d for d in V6_FORBIDDEN_DIRS if d not in L.FORBIDDEN_DIRS)
    L3.SELF_EXEMPT.update(SELF_EXEMPT_V6)
    rc = L5.main(argv)                      # applies the v5, v4 and v3 additions, sets the root, runs the v2 scan
    files = [f for f in L.candidate_files("--tree" in argv) if f not in L3.SELF_EXEMPT]
    v = [("AI_RUN_OUTPUT", f, "AI consistency kit or run output (investigators only; never committed)")
         for f in files if AI_RUN_PATH.search(f)]
    if private:
        v += deep_check(files, L.ROOT, private)
    for kind, f, why in v:
        print(f"{kind}\t{f}\t{why}")
    print(f"v6 checks (AI consistency run paths{', deep check against ' + str(len(private)) + ' private file(s)' if private else ''}), "
          f"{len(files)} files: {len(v)} violation(s)")
    return 1 if (rc or v) else 0


if __name__ == "__main__":
    sys.exit(main())
