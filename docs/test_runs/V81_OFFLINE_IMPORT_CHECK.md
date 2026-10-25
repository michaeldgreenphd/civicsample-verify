# Offline import compatibility — 2026-10-25

Scope: revision-2 transfer inputs, full migration chain through 0036, disposable in-memory PGlite only. The investigator has requested a new proposed sample matched to the final model; the existing alternatives tested here are not selected or release-ready samples.

## Observed checks

| Command/check                                                                               | Observed result                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transfer checksum verification                                                              | 30/30 top-level entries; 6/6 private entries matched. No private values copied into the repository.                                                                                                                                                              |
| `npm run --silent mu81:offline-import-check -- --private-dir <absolute external directory>` | PASS for both alternatives: 100 units each; original packet hashes matched for all 100; database unit-list, assignment-set and design-row manifests matched; 200 queue positions checked in memory; probability binding accepted for all 100 ONE_PER_TRIAL rows. |
| `node --import tsx --test tests/mu81-disposable-import.test.ts`                             | 7 passed, zero failed/skipped. Fully synthetic positive SQL runs for both alternatives; checksum/traversal/repository/symlink refusals; unchanged nominal-probability guard; safe output on file and database errors.                                            |
| `VERIFY_ANALYSIS_PYTHON=<local Python interpreter> npm run check`                           | 314 passed, zero failed, 34 skipped, one existing TODO. Includes both database-to-Python history/probability checks (36 passed each). TypeScript, lint and all fixture/leakage scanners passed.                                                                  |
| `npm run build`                                                                             | PASS; 7 manifests and 38 SQL inputs; no local runtime files in the production trace.                                                                                                                                                                             |

No approvals, freeze, phase transitions, queue assignments, judgments, adjudications, snapshot, reference lock or exports were created in either disposable input check. No remote database was contacted. Input files were read-only, and no database files were persisted.

## Limits

- Live PostgreSQL and Supabase acceptance for this command: **NOT TESTED**. Local native tests remain **BLOCKED** without a configured test server. Prior-head hosted PostgreSQL results do not constitute a new command's live verification.
- The identity is a synthetic investigator with simulated MFA claims through the local auth shim. No real JWT or deployed policy verification is claimed.
- Browser E2E was not repeated for this CLI/documentation-only increment. No application route, reviewer screen, migration, served rubric or runtime export behavior changed.
- Existing packets were compared to the checksummed companion's original canonical-JSON inventory. Database JSONB hashes were independently checked internally. This does not invent or certify an external database-frozen inventory.
- Frame adequacy, new sampling, estimator acceptance and the unresolved rubric passages are outside this compatibility check.

## Formatting and diff checks

`git diff --check` passed. Changed-file Prettier checks passed. Repository-wide `npm run format:check` reports 14 unchanged baseline files (one browser test and preserved v7 fixtures/design documents); those files were not reformatted in this increment. The full format gate is therefore **FAIL (existing baseline)**, not PASS.
