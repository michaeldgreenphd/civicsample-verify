# Mixed ISO timestamp precision — 2026-10-24

The analysis job in push run 40113340880 (job 120929440899) failed in the
database-to-v4-export-to-Python test: a valid `first_submitted_at` column was
reported as containing unreadable timestamps. This was a real intermittent
parser defect, not an infrastructure-only failure.

Pandas inferred one timestamp format from the first string. A column containing
both fractional seconds and whole seconds then produced missing parsed values.
The same parser was present in both maintained v4 and v5 analysis modules.
Explicit ISO 8601 parsing now accepts those representations and preserves UTC
instants. Missing, malformed and impossible dates still refuse the export.
No estimand, denominator, data, migration or scientific approval changed.

## Executed evidence

- Before the fix, `python -m pytest -q analysis/test_timestamp_columns.py`:
  4 failed, 8 passed. Mixed-precision cases failed for both versions and both
  input orders; invalid-input refusals passed.
- After the fix, the same command: 12 passed.
- `python -m pytest -q analysis/test_timestamp_columns.py
analysis/test_performance_analysis_v4.py -k 'timestamp_precision or timestamp_still'`:
  13 passed, 62 deselected. A complete synthetic v4 bundle produces identical
  serialized results when only equivalent timestamp representations change.
- `MU7_ALLOW_NO_DB_BUNDLE=1 python -m pytest -q analysis`:
  397 passed, 1 skipped. The existing database-written v7 bundle check is run by
  the Node cross-language suite; its standalone Python invocation can be skipped
  without a configured bundle path.
- `npm run build`: PASS, 34 SQL inputs in the production trace allowlist.
- `VERIFY_ANALYSIS_PYTHON=/path/to/venv/bin/python npm run check`: PASS,
  241 Node tests passed, 31 skipped (native PostgreSQL/live staging unavailable),
  1 existing proposal to-do. Cross-language export tests executed. Typecheck,
  lint and all fixture/leakage scans passed.
- `npm run test:e2e:production`: PASS, 9 synthetic served-browser scenarios.
- `npm run test:handoff`: PASS with the existing documented differences:
  schema-version enumeration and stricter adjudicator access; current v7 chain
  360/362. These exceptions were not changed by this patch.
- `npm run format:check`: FAIL on 15 existing supplied-file formatting warnings;
  no supplied file was reformatted. The new report passes Prettier.
- `git diff --check`: PASS.

Python was the existing virtual environment with the repository's pinned
requirements. All evidence is synthetic. No Supabase or operational database
was contacted. Native PostgreSQL remains unavailable locally; hosted CI is
required for current-head native results.
