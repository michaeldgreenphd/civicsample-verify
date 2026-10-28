# Release controls verification — 2026-10-27

Scope: generalized application code and fictional fixtures only. No study packet, identifier,
response or private checksum is reproduced in this record. No operational database was changed.

## Executed targeted checks

- `node --import tsx --test tests/formal-release.test.ts tests/sample-agreement.test.ts`: PASS,
  four tests passed; one native PostgreSQL variant skipped because no local server is available.
  The full-size disposable lifecycle includes a separate 12-unit rehearsal, 100 formal-format
  fictional mappings, 200 final judgments, subgroup observations, stale-plan rejection,
  rollback of wrong queues, gate refusal, two finishes, both-Cannot-tell adjudication, reference
  lock, registration and a verified descriptive report. Source study files are never read.
- `npm run test:handoff`: PASS with the preserved documented exceptions; final chain through
  0042 runs 360/362 supplied steps. The differing steps are the version inventory and the
  deliberately stricter adjudicator boundary, not waived data-integrity failures.

Full-suite, build and served-browser results will be recorded after execution. Native PostgreSQL
is wired into the hosted CI service; no result from PGlite substitutes for that run. Supabase
deployment, live JWT/session checks, real rehearsal acceptance, backup/recovery, investigator
approvals and clinical opening remain NOT TESTED for this increment.

`npm run format:check` identified 13 pre-existing format differences in byte-preserved v7
handoff fixtures, suites and documentation. Those files were not reformatted. Changed application
files are formatted separately; `git diff --check` is required before commit.

The preceding export-inventory fix in PR #43, commit `cb86cb0`, has six successful hosted jobs
(web, analysis and PostgreSQL for both events). Its review finding was answered and resolved.
