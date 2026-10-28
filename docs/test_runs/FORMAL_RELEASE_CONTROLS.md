# Release controls verification — 2026-10-27

Scope: generalized application code and fictional fixtures only. No study packet, identifier,
response or private checksum is reproduced in this record. No operational database was changed.

## Executed local checks

- `node --import tsx --test tests/formal-preparation.test.ts tests/formal-release.test.ts tests/sample-agreement.test.ts`: PASS,
  eight tests passed; one native PostgreSQL variant skipped because no local server is available.
  The full-size disposable lifecycle includes a separate 12-unit rehearsal, 100 formal-format
  fictional mappings, 200 final judgments, subgroup observations, stale-plan rejection,
  rollback of wrong queues, gate refusal, two finishes, both-Cannot-tell adjudication, reference
  lock, registration and a verified descriptive report. Source study files are never read.
- `npm run test:handoff`: PASS with the preserved documented exceptions; final chain through
  0042 runs 360/362 supplied steps. The differing steps are the version inventory and the
  deliberately stricter adjudicator boundary, not waived data-integrity failures.

- `npm run build`: PASS from a clean verification checkout at `3089b7e`; production traces
  include seven manifests and 44 required SQL inputs, with no local runtime files.
- `npm run test:e2e:production`: PASS, 28/28 served-browser scenarios on that optimized build.
  The release-control screen was checked at desktop, 390px and 320px widths, with no horizontal
  page overflow or automated WCAG A/AA violations. Screenshots were visually inspected.
- `npm run typecheck` and `npm run lint`: PASS after the status-display correction.

- `VERIFY_ANALYSIS_PYTHON=<local-venv>/bin/python npm run check`: final code at `3089b7e`,
  419 passed, zero failures, 44 explicitly skipped and one existing TODO. TypeScript, ESLint
  and source/index leakage checks are part of this command.
- Native PostgreSQL 16: the hosted [push job at `3089b7e`](https://github.com/michaeldgreenphd/civicsample-verify/actions/runs/40621483997/job/122596318303)
  succeeded. Its per-test log confirms the new full formal-release/export lifecycle executed
  successfully against PostgreSQL, rather than being skipped.

Supabase
deployment, live JWT/session checks, real rehearsal acceptance, backup/recovery, investigator
approvals and clinical opening remain NOT TESTED for this increment.

`npm run format:check` identified 13 pre-existing format differences in byte-preserved v7
handoff fixtures, suites and documentation. Those files were not reformatted. Changed application
files are formatted separately; `git diff --check` is required before commit.

The release controls are in draft PR #44, stacked on #43. Independent review is requested.

The preceding export-inventory fix in PR #43, commit `cb86cb0`, has six successful hosted jobs
(web, analysis and PostgreSQL for both events). Its review finding was answered and resolved.
