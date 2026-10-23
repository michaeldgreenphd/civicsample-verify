# Hosted synthetic practice preparation

The operator completed the v7 synthetic Supabase pilot on 2026-10-23. Independently
executed against the live staging service: reviewer phase 1/1 PASS; adjudicator
phase 2/2 PASS; after-lock phase 1/1 PASS. Other phases were explicitly unselected,
not passes. The earlier restrictions/account-lock results belong to the prior
operator's run and were not rerun during this verification.

Read-only inspection confirmed 12 PILOT units, three separate training examples,
24 assignments, 24 judgments, five adjudications, one 12-unit pilot reference lock
and one registered export. No formal freeze, phase event or gate approval existed.
The earlier mapping-confirmation pilot was preserved.

The five downloaded bundle files passed `scripts/verify-mu7-bundle.ts`, including
comparison against the manifest checksum read from the database: 12 units,
12 design rows, 24 independent judgments, 12 final references. All file hashes,
column lists and row counts matched. The manifest labels the bundle synthetic and
excluded from statistics. Operational files remain outside the repository.

This verifies the pilot workflow, not readiness for real clinical review or a
public deployment. Public HTTPS, hosting logs, restarts, fresh colleague practice
accounts and full Auth recovery still require acceptance checks.

## Hosting branch checks

- `VERIFY_ANALYSIS_PYTHON=<existing private environment>/bin/python npm run check`:
  257 tests, 226 PASS, 0 FAIL, 30 skipped, 1 TODO. Native database/live phases
  unavailable or not selected are not counted as passes. Typecheck and lint pass.
- `npm run build`: PASS, 7 production trace manifests, 32 SQL inputs, no local
  runtime files. Pages render dynamically with per-response script nonces.
- `npm run test:e2e:production`: 6/6 PASS. A subsequently added hosted-navigation
  regression plus the CSP browser check passed 2/2 in a targeted served run.
  The first CSP test used DevTools script execution, which is trusted by
  strict-dynamic; the corrected regression injects an unnonced script into the
  HTML response and verifies that the browser blocks it. No policy was relaxed.
- `npm run format:check`: FAIL on 16 unchanged baseline files, including supplied
  handoff fixtures/documents. They were not reformatted. Prettier on every changed
  source/document and `git diff --check`: PASS.
- The full prior handoff suites and native PostgreSQL concurrency suites were not
  rerun for these hosting-only changes. No migrations changed.
- Public Render HTTPS, proxy headers/cookies, real-origin mutation rejection,
  provider logs, remote startup and restart persistence: NOT TESTED until deployed.
