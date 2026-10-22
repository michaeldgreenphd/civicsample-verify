#!/usr/bin/env python3
"""
tools/check_public_repo_leakage.py (adapted from handoff v2)

Fails (exit 1) when the repository, or the set of files git would commit, contains study data or
secrets that must never reach a repository that reviewers or the public could read. Checks:
  1. forbidden files by name: REVIEW_SAMPLE*.csv, AI_CLASSIFICATIONS*.jsonl, DECISION_FILE*.csv,
     TRIAL_LEVEL_DECISIONS*.csv, SAMPLING_FRAME*.csv, stage_comparison*.csv, STAGE_C_*, packets_v1.jsonl,
     trial_context_primary*, curated_trial_area_flags*, PPR_benchmark_provenance*, the PCORnet query
     workbook, app exports, signed pilot checklists, secrets files, anything under data_private/,
     exports/ or results/ (except data_private/README_DATA_PRIVATE.md);
  2. forbidden content in any text file: PCORnet 2023 query benchmark IDs, workbook name and values
     (marked internal use, pending permission to publish), AI classification records (prompt hash
     together with model id), JWT-shaped secrets, a service-role key assignment;
  3. forbidden content in data-like files (csv, tsv, json, jsonl, sql, txt): decision-file headers and
     real-format NCT IDs (synthetic fixtures must use NCT99xxxxxx);
  4. required .gitignore entries missing;
  5. with --history: any forbidden file name that was ever committed on any branch.
  6. data containers (xlsx, parquet, gz, zip, sqlite and similar) anywhere in the tree, because their
     content cannot be scanned; images and PDFs are checked by name only.
An allowlist file (.leakage_allowlist, one 'path<TAB>reason' per line) can exempt a path from the NCT ID
check and the data-container check only; checks 1, 2, 4 and 5 cannot be allowlisted.

Usage (repository root):
    python tools/check_public_repo_leakage.py             # files git tracks or would add (falls back to the tree)
    python tools/check_public_repo_leakage.py --tree      # public source and indexed blobs
    python tools/check_public_repo_leakage.py --history   # also scan the names of every file ever committed
Exit 0 when clean, 1 when any violation is found. Run it in CI and as a pre-commit hook.
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

FORBIDDEN_NAME_PATTERNS = [
    "REVIEW_SAMPLE*.csv", "AI_CLASSIFICATIONS*.jsonl", "DECISION_FILE*.csv", "TRIAL_LEVEL_DECISIONS*.csv",
    "SAMPLING_FRAME*.csv", "stage_comparison*.csv", "STAGE_C_*", "packets_v1.jsonl", "trial_context_primary*",
    "curated_trial_area_flags*", "PPR_benchmark_provenance*", "table1_2023_q01_report*",
    "pcornet_reference_percentfemale*", "*_analysis_export_*.csv", "*_reviews_effective_*.csv",
    "*_reviews_history_*.csv", "*_adjudications_*.csv", "*_approved_decisions_*.csv", "*_audit_log_*.csv",
    "*_export_bundle_*.json", "PILOT_ACCEPTANCE_CHECKLIST_signed*", "clinical_review_results_block.md",
    "clinical_review_results_metrics.json", ".env", ".env.*", "*.env", "secrets.toml", "*.pem", "*.key",
]
FORBIDDEN_DIRS = ["data_private/", "exports/", "results/"]
DIR_EXCEPTIONS = {"data_private/README_DATA_PRIVATE.md"}
# Synthetic fixtures shipped with the package are allowed by name.
NAME_EXCEPTIONS = {"validation/fixtures/synthetic_formal_analysis_export.csv",
                   "validation/fixtures/synthetic_formal_analysis_export.manifest.json"}
DATA_SUFFIXES = {".csv", ".tsv", ".json", ".jsonl", ".sql", ".txt"}
# Binary formats: content is not scanned (no meaningful text); data containers are flagged for review.
BINARY_SUFFIXES = {".png", ".pdf", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".otf"}
DATA_CONTAINER_SUFFIXES = {".xlsx", ".xls", ".parquet", ".feather", ".gz", ".zip", ".sqlite", ".db", ".rds", ".dta", ".sav"}

# (label, pattern, scope): scope "all" = every text file, "data" = data-like files only.
CONTENT_RULES = [
    ("PCORnet 2023 query benchmark ID (internal use)", re.compile(r"\bPCN23-[A-Z]+"), "all"),
    ("PCORnet 2023 query workbook name", re.compile(r"table1_2023_q01_report", re.I), "all"),
    ("AI classification record (prompt hash and model id)",
     re.compile(r'"prompt_sha256"\s*:\s*"[0-9a-f]{64}".{0,400}"model_id"|"model_id".{0,400}"prompt_sha256"\s*:\s*"[0-9a-f]{64}"',
                re.S), "all"),
    ("JWT-shaped secret", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"), "all"),
    ("service-role key assignment", re.compile(r"SUPABASE_SERVICE_ROLE_KEY\s*[=:]\s*['\"]?[A-Za-z0-9_.-]{20,}"), "all"),
    ("decision-file header (provisional_curated_status with source_stage)",
     re.compile(r"^[^\n]*(?:provisional_curated_status[^\n]*source_stage|source_stage[^\n]*provisional_curated_status)", re.M),
     "data"),
]
# PCORnet 2023 query values marked internal use: only SHA-256 digests of their first four decimals are stored,
# so this tool does not disclose the values. Every decimal token 0.dddd... is truncated to 0.dddd, hashed and
# compared; a hit is reported by label only, never by value.
PCORNET_VALUE_SHA256 = {
    "427175a2f641b982fac98f5b3be5a6ea8b484cdc2d64c8f4a7badcfb8a5d9ebe",
    "92039333635d506a68109786dac5a3a846075715489b7c5f45ae248fba902ecd",
    "e042754234ebd23f35b90604f6efbc98af968240d8d96b173e40db6dca0abdcb",
}
DECIMAL_RE = re.compile(r"\b0\.\d{4,}\b")


def pcornet_value_present(text: str) -> bool:
    return any(hashlib.sha256(m.group(0)[:6].encode()).hexdigest() in PCORNET_VALUE_SHA256
               for m in DECIMAL_RE.finditer(text))


# Only this tool may contain the patterns above (it defines them).
CONTENT_EXCEPTIONS = {"tools/check_public_repo_leakage.py"}
NCT_RE = re.compile(r"\bNCT(?!99)\d{8}\b")
REQUIRED_GITIGNORE = ["/REVIEW_SAMPLE.csv", "AI_CLASSIFICATIONS*.jsonl", "/data_private/", "/exports/", "/results/",
                      "DECISION_FILE*.csv", "TRIAL_LEVEL_DECISIONS*.csv", "SAMPLING_FRAME*.csv", "PPR_benchmark_provenance*",
                      "packets_v1.jsonl", "trial_context_primary*", ".env", "secrets.toml"]


# Adapted from the public handoff checker: retain its rules, scan the Git index,
# redact all diagnostic paths/values, and exclude runtime artifacts only if ignored.
RUNTIME_NAMES = {"node_modules", ".venv", "venv", "__pycache__", ".pytest_cache",
                 ".next", ".local", "test-results", "playwright-report", "coverage",
                 "out", "artifacts"}
NAME_EXCEPTIONS.add(".env.example")  # name only; all content rules still apply
NAME_EXCEPTIONS.update({
    "analysis/fixtures/synthetic_v4_independent_judgments.csv",
    "analysis/fixtures/synthetic_v4_adjudicated_reference.csv",
    "analysis/fixtures/synthetic_v4_frozen_predictions.csv",
    "analysis/fixtures/synthetic_v4_bundle.manifest.json",
})


def git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, check=True).stdout


def _skip(rel: str) -> bool:
    if rel.split("/")[0] == ".git":
        return True
    if not (set(rel.split("/")) & RUNTIME_NAMES or rel == ".env.local"):
        return False
    try:
        git("check-ignore", "-q", "--", rel)
        return True
    except (OSError, subprocess.CalledProcessError):
        return False


def candidate_files(use_tree: bool) -> list[str]:
    # Even ignored runtime directories can contain tracked files; always union
    # tracked paths back in. Indexed content is inspected separately below.
    files = set()
    try:
        tracked = git("ls-files", "-z", "--cached").decode().split("\0")
        files.update(f for f in tracked if f)
        if not use_tree:
            files.update(f for f in git("ls-files", "-z", "--others", "--exclude-standard").decode().split("\0") if f)
            return sorted(files)
    except (OSError, UnicodeError, subprocess.CalledProcessError):
        pass
    def walk(directory):
        for p in directory.iterdir():
            rel = p.relative_to(ROOT).as_posix()
            if _skip(rel):
                continue
            if p.is_symlink() or p.is_file():
                files.add(rel)
            elif p.is_dir():
                walk(p)
    walk(ROOT)
    return sorted(files)


def source_entries(files):
    """Return (path, bytes, error) for public working files AND immutable index blobs."""
    for f in files:
        p = ROOT / f
        try:
            if p.is_symlink():
                yield f, b"", "SYMLINK"
            elif p.is_file():
                if p.stat().st_size > 50_000_000:
                    yield f, b"", "LARGE_FILE"
                else:
                    yield f, p.read_bytes(), None
        except OSError:
            yield f, b"", "UNREADABLE_FILE"
    try:
        records = git("ls-files", "--stage", "-z").decode().split("\0")
    except (OSError, UnicodeError, subprocess.CalledProcessError):
        if (ROOT / ".git").exists():
            yield "", b"", "INDEX_UNREADABLE"
        return
    for record in filter(None, records):
        try:
            meta, f = record.split("\t", 1)
            mode, oid, stage = meta.split(" ")
            if stage != "0" or mode not in {"100644", "100755"}:
                yield f, b"", "UNSAFE_INDEX_ENTRY"
                continue
            if not re.fullmatch(r"[a-f0-9]{40,64}", oid):
                raise ValueError()
            if int(git("cat-file", "-s", oid)) > 50_000_000:
                yield f, b"", "LARGE_FILE"
                continue
            yield f, git("cat-file", "blob", oid), None
        except (OSError, ValueError, subprocess.CalledProcessError):
            yield "", b"", "INDEX_UNREADABLE"


def history_names() -> list[str]:
    try:
        return sorted(set(filter(None, git("log", "--all", "--name-only", "--pretty=format:").decode().splitlines())))
    except (OSError, UnicodeError, subprocess.CalledProcessError):
        return []


def name_violations(f: str) -> list[tuple[str, str, str]]:
    v = []
    if f not in NAME_EXCEPTIONS and any(fnmatch.fnmatch(Path(f).name, pat) for pat in FORBIDDEN_NAME_PATTERNS):
        v.append(("FORBIDDEN_FILE", f, "private filename"))
    if any(f.startswith(d) for d in FORBIDDEN_DIRS) and f not in DIR_EXCEPTIONS:
        v.append(("FORBIDDEN_DIR", f, "private directory"))
    return v


def report(violations):
    # Neither filenames nor matched contents are safe diagnostics: both may name units.
    from collections import Counter
    for kind, count in sorted(Counter(v[0] for v in violations).items()):
        print(f"{kind}: {count} violation(s); values and paths withheld")


def javascript_guard():
    checker = Path(__file__).resolve().parents[1] / "scripts/check-fixtures.mjs"
    if not checker.is_file():
        return [("JAVASCRIPT_GUARD_UNAVAILABLE", "", "")]
    try:
        result = subprocess.run(["node", str(checker), str(ROOT)], capture_output=True)
        return [] if result.returncode == 0 else [("JAVASCRIPT_GUARD_FAILED", "", "")]
    except OSError:
        return [("JAVASCRIPT_GUARD_UNAVAILABLE", "", "")]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tree", action="store_true", help="scan public source including ignored non-runtime files, plus indexed blobs")
    ap.add_argument("--history", action="store_true")
    a = ap.parse_args(argv)
    files = candidate_files(a.tree)
    allow = {}
    al = ROOT / ".leakage_allowlist"
    if al.exists():
        for line in al.read_text(encoding="utf-8").splitlines():
            if line.strip() and not line.startswith("#"):
                path, _, reason = line.partition("\t")
                if reason.strip():
                    allow[path.strip()] = reason.strip()
    v = []
    for f, raw, error in source_entries(files):
        v.extend(name_violations(f))
        if error:
            v.append((error, f, ""))
            continue
        suffix = Path(f).suffix.lower()
        if suffix in DATA_CONTAINER_SUFFIXES and f not in allow:
            v.append(("DATA_CONTAINER", f, ""))
            continue
        if suffix in BINARY_SUFFIXES:
            continue
        text = raw.decode("utf-8", errors="ignore")
        is_data = suffix in DATA_SUFFIXES
        if f not in CONTENT_EXCEPTIONS:
            for label, rx, scope in CONTENT_RULES:
                if (scope == "all" or is_data) and rx.search(text):
                    v.append(("FORBIDDEN_CONTENT", f, label))
            if pcornet_value_present(text):
                v.append(("FORBIDDEN_CONTENT", f, "private benchmark value"))
        if is_data and f not in allow and NCT_RE.search(text):
            v.append(("REAL_NCT_ID", f, ""))
    gi = ROOT / ".gitignore"
    glines = set(gi.read_text().splitlines()) if gi.exists() else set()
    for entry in REQUIRED_GITIGNORE:
        if entry not in glines:
            v.append(("GITIGNORE", "", ""))
    if a.history:
        for f in history_names():
            v.extend(("HISTORY_" + k, "", "") for k, _, _ in name_violations(f))
    v.extend(javascript_guard())
    report(v)
    print(f"checked {len(files)} public paths plus indexed blobs: {len(v)} violation(s)")
    return 1 if v else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, UnicodeError, ValueError, IndexError):
        print("SCAN_FAILED: 1 violation(s); input paths and values withheld")
        sys.exit(1)
