# Freeze-gate patch review — 2026-10-24

Scope: rubric 7.1 and additive migration 0032, based on `6300cf9`.
The received patch SHA-256 was
`0b0236afc9f93b52579efdb48b24019b70f2587521eff718a000777a42f97509`;
the imported tree matched `3ddaba9abaffbcc38ecfe8aae0701fc8e1f1adcf` exactly.
The follow-up adds upgrade/authorization coverage and corrects the rubric-delivery claims.
It does not alter migration 0032 or the approved rubric bytes.

## Decision and review conclusions

- The investigator explicitly confirmed on 2026-10-24: require G-EST-01 before freeze.
  This authorizes gate placement only. The estimator is still pending specification,
  and no application gate approval is created by this change.
- Migration 0032 inserts four requirement versions and its schema marker. Historical
  migrations, requirements, approvals, units and judgments are not rewritten.
- Pain version 3 names the complete decision reference and rubric 7.1 checksum.
  Version 2 remains in history but cannot satisfy the new requirement.
- A regression now starts with the pre-0032 schema, stored synthetic pilot/formal
  units and an existing Pain version 2 approval. It applies 0032, checks preservation
  of units, judgments, adjudications, design rows, approvals and recomputed hashes, demonstrates the freeze
  refusal, and tests re-approval. Reviewer, adjudicator, outsider and investigator
  sessions without MFA are refused. Satisfying Pain alone does not satisfy the other gates.
- The same upgrade regression is included in the hosted PostgreSQL 16 CI job.
  The preserved handoff suites use their existing test-only gate shim; their success
  is not evidence that actual study decisions are approved.

## Remaining findings

**Blocker before formal review: rubric delivery is incomplete.**
`docs/design_v7/RUBRIC_PROVENANCE_v7.md:25` now makes this explicit.
The source hash and exact Pain-only edit are verified, but
`src/app/mu7-workspace.tsx:284`, `src/lib/mu7-types.ts` and
`src/server/mu7-core.ts` have no delivered, versioned v7 rubric.
The provenance test verifies source content, not text received by a reviewer.
Before formal opening, implement approved reviewer-facing guidance with a bound
version/checksum and served-browser assertions. Review the content boundary before
exposing the complete engineering document, which also contains pending status and
design details. This patch does not claim to implement that follow-up.

**Note: seven-area coverage does not become ten-area coverage.**
The investigator's accompanying handoff describes a manuscript expansion while the
review sample remains based on seven areas. This patch neither redraws the sample nor
changes its claim of coverage. Scope, sampling and any revised rubric need a separate
investigator decision before freeze.

**Not verified:** a private dry run against the proposed sample and its four Pain
units; no private study data was loaded. Public regressions use a smaller synthetic
formal fixture, including a Pain unit, and do not establish sampling adequacy.

## Executed checks

All local runs used this isolated checkout and synthetic disposable databases.
`VERIFY_ANALYSIS_PYTHON` pointed to the existing local analysis virtual environment.

| Command                                                                      | Observed result                                                                                                                                                           |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VERIFY_ANALYSIS_PYTHON=<local-python> npm run check` after review additions | PASS: 241 passed, 0 failed, 31 skipped, 1 todo; typecheck/lint and fixture/v4/v5/v7 leakage checks passed                                                                 |
| `node --import tsx --test tests/mu7-gates-upgrade.test.ts`                   | PASS: 1 passed; native PostgreSQL variant BLOCKED locally                                                                                                                 |
| `npm run typecheck` and `npm run lint` after the upgrade test                | PASS                                                                                                                                                                      |
| `npm run build`                                                              | PASS: 7 trace manifests, 34 SQL inputs, no local runtime files                                                                                                            |
| `npm run test:e2e:production`                                                | PASS: 9 served-browser scenarios; local synthetic database, some hosted-identity scenarios mocked                                                                         |
| `MU7_ALLOW_NO_DB_BUNDLE=1 <local-python> -m pytest -q analysis`              | PASS: 384 passed, 1 skipped; the full check also exercises database-written export to Python                                                                              |
| `npm run test:handoff`                                                       | PASS with documented exceptions: v7 full migration chain 360/362 (`MU7-SCHEMA-01`, `MU7-ADD-01`); earlier supplied suites retain their documented version-list exceptions |
| `npm run format:check`                                                       | FAIL: 15 files; each also fails at base `6300cf9`. Preserved/hash-bound handoff files were not reformatted                                                                |
| `git diff --check`                                                           | PASS                                                                                                                                                                      |
| Local native PostgreSQL 16                                                   | BLOCKED: no local server configured                                                                                                                                       |
| Live Supabase and Render                                                     | NOT TESTED in this review; neither was changed                                                                                                                            |

The new role-negative test initially expected a guard code instead of the existing
investigator/MFA error text. The test expectation was corrected; no authorization
logic changed. Passing synthetic tests is not a clinical result or formal approval.
