# V8 database foundation

This additive increment prepares a separate v8 database. It does not select a
sample, approve a policy, change the live practice app, or enable formal review.
The v8 analysis remains synthetic-only.

## Behavior

Migration `0033_v8_design_foundation.sql` adds the proposed Pathological, Immune,
and Urogenital area vocabulary. Review and training imports may use those added
categories only after a v8 design is recorded. The existing seven labels remain
byte-identical.

Recording a new v8 design atomically appends pending specifications for
G-ALLOC-01, G-AREA-01, G-TEXT-02 and G-RUBRIC-01. Each blocks the freeze.
Frame-sensitive existing requirements also receive a new pending version, so
v7 approvals cannot authorize a different v8 sample, policy or estimator. Pain
retains its current-unit freeze guard and formal-open requirement. G-PROV-04 is
information-only unless an investigator subsequently changes its specification.
All approvals remain separate investigator actions.

The real v8 design version requires 96 primary and four subgroup mappings in
its planned counts. Synthetic test designs can be smaller. This count check does
not yet enforce the 56-area/40-row allocation within the 96 primary mappings.
The singleton design constraint prevents recording both alternative draws.

Applying this migration to a v7 database preserves its design, units, judgments,
requirements and approvals. It does not convert that database to v8. An already
recorded v8 design is refused by the migration rather than treated as reconciled.
Use a fresh disposable database for v8 testing; retain the existing v7 practice
records. No migration has been applied remotely by this increment.

## Verification scope

The new tests exercise real RPCs in disposable PGlite databases: pending gates,
role denial, design counts, the singleton boundary, added review and training
categories, preservation of an active v7 practice, and refusal of an unreconciled
v8 upgrade. Each new freeze gate is tested in isolation with all other synthetic
gates satisfied; approval in the disposable fixture permits the freeze without
changing its component hashes.

An eight-unit engineering fixture also passes through the application exporter
and produces 16 initial judgments with the v8 design version. This is not the
100-unit acceptance run or the database-to-Python analysis check. The hosted
PostgreSQL 16 job includes the new gate/category/role test; it must pass on the
PR head before this increment is considered validated on native PostgreSQL.

## Remaining work

- Bind the approved v8 rubric and packet wording without rewriting frozen v7 data.
- Enforce and test the approved allocation within the 100-unit sample.
- Run a complete synthetic 100-unit, 200-judgment lifecycle through the database,
  exporter and v8 Python analysis, including adjudication and indeterminate answers.
- Validate the private alternatives outside the repository and record the
  investigator's choice and remaining scientific approvals.
- Review an explicit staging migration plan and run live token/RLS checks after
  separate authorization. Local tests do not establish Supabase behavior.

The existing app's synthetic design creation screen remains v7. This foundation
is not a release of a v8 clinician workflow.

## Executed checks (2026-10-24)

- `VERIFY_ANALYSIS_PYTHON=<local-analysis-venv-python> npm run check`: typecheck,
  lint and Node tests passed (250 passed, 0 failed, 32 skipped, one existing todo).
  Fixture and v4/v5/v7 leakage scans passed with zero violations.

- `node --import tsx --test tests/mu8-foundation.test.ts`: 9 passed, 0 failed;
  one native PostgreSQL check skipped because no local test server is available.
- `npm run test:handoff`: passed its expected-outcome checks. The final v7 chain
  through 0033 has 360/362 passing steps; the only exceptions remain the already
  documented schema-version list and stricter adjudicator authorization checks.
  No new exception was allowlisted.
- `npm run build`: passed; seven trace manifests, 35 SQL inputs and no local runtime
  files in the production trace.
- `npm run test:e2e:production`: 9/9 passed against a local in-memory synthetic
  database. This verifies existing app workflows after the schema addition, not
  a completed v8 clinician workflow or hosted authentication.
- Changed-file Prettier and `git diff --check`: passed. Repository-wide
  `npm run format:check` still fails on 14 unchanged files. The same command at
  the base commit flagged those 14 plus the script formatted in this increment.
  Preserved handoff sources were not reformatted to hide this pre-existing result.
- Live Supabase: NOT TESTED; no remote schema, account or data changes were made.
- Migration SHA-256:
  `bc10e48718b1e0674720fc1cc4df8b1aed5e1ae26f9b6b281b4683ff64e787ad`.
