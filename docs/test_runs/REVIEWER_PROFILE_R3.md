# Reviewer guide revision 3 and sample preparation

Executed 25 October 2026 on `codex/v81-review-preparation`, based on `0fe26d3`
(PR #25), with practice/reference navigation from `8be014e` (PR #13).
Local results below describe the integrated working tree; hosted CI must verify
the published head separately.

## Result

All ten areas use the displayed MeSH parent-heading scope. The extra narrowed
definitions for the three added areas are withdrawn. Reviewers still judge
clinical fit, and the separate cancer, Depression and smoking-cessation policies
remain. The exact guide is bound before any new review or training activity;
historical records retain their original wording and meaning.

The new private preparation package passed the actual import and probability
binding functions in a disposable in-memory database: 100 mappings, 200 planned
queue positions, 98 packets unchanged and two intended neoplasm statement edits.
The unit list, assignment set, design rows, queue and probability source were
unchanged. No sample was redrawn or selected, and no approvals, assignments,
judgments, freezes or exports were created by that check. Source study files
remain intact outside Git. No remote request was made.

## Executed checks

`<analysis-python>` below denotes the existing local virtual environment with
`analysis/requirements.txt` installed; `<private-package>` is an owner-only
directory outside every repository. Neither path nor its contents is part of
the public fixture suite.

| Command                                                                                            | Observed result                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VERIFY_ANALYSIS_PYTHON=<analysis-python> npm run check`                                           | PASS: typecheck and lint; 377 tests, 339 passed, 0 failed, 37 skipped, 1 TODO; sensitive-fixture scan and v4/v5/v7 leakage scans each passed with zero violations.                             |
| `MU7_ALLOW_NO_DB_BUNDLE=1 MU8_ALLOW_NO_DB_BUNDLE=1 <analysis-python> -B -m pytest -q analysis`     | PASS: 563 passed, 39 skipped in the standalone run. Database-written bundle tests are exercised separately by the Node roundtrip tests in `npm run check`.                                     |
| `npm run test:handoff`                                                                             | PASS with existing documented exceptions. v5 457/457; v5.1 reference 534/534; v7 through 0037 360/362 (schema-list and intentionally stricter adjudicator check). No new exception introduced. |
| `npm run build`                                                                                    | PASS: 7 production manifests, 39 SQL inputs, exact guide included, no private runtime files traced.                                                                                            |
| `npm run test:e2e:production`                                                                      | PASS: 11/11 scenarios against a locally served production build.                                                                                                                               |
| `npm run mu81:offline-import-check -- --private-dir <private-package> --alternative ONE_PER_TRIAL` | PASS: actual PGlite RPC imports, 100 probability-binding rows, canonical packet digests and manifest invariants verified. No live JWT or remote service involved.                              |
| Prettier check of all changed supported files                                                      | PASS.                                                                                                                                                                                          |
| `git diff --check`                                                                                 | PASS.                                                                                                                                                                                          |
| `npm run format:check`                                                                             | FAIL on 13 unchanged supplied v7 files. Their preserved bytes were not reformatted; details below.                                                                                             |
| Native PostgreSQL and concurrency locally                                                          | BLOCKED: no local PostgreSQL test service. New profile races are wired into the hosted PostgreSQL 16 job.                                                                                      |
| Supabase / existing hosted practice                                                                | NOT TESTED for this increment; neither service was modified.                                                                                                                                   |

The 37 Node skips cover unavailable native PostgreSQL and live-staging checks;
the one existing TODO concerns the separately proposed cross-design guard.
Skipped or TODO results are not passes.

## Coverage and corrections

- Profile binding requires an active investigator with MFA, the exact guide
  checksum, a v8.1 design, and no prior units, training or review activity.
  Reviewers, adjudicators, anonymous callers, locked accounts and direct table
  writes are refused. Binding does not approve any scientific gate.
- Upgrade checks preserve existing v7 and unbound v8.1 packets, judgments,
  reference locks and exports. New bundle 8.3 requires the guide and complete
  history, while older formats reject profile-specific reasons.
- Synthetic database-to-TypeScript-to-Python roundtrips exercise the new bundle,
  guide integrity, complete revisions, separate subtype answers and probability
  provenance. Real-study analysis remains disabled pending its analysis plan.
- The private checker reconstructs the two permitted edits from the checksummed
  source import. Regression tests reject an unreported third packet edit even
  when a revised checksum and reported counts appear consistent.
- Browser scenarios cover separate Practice cases, Worked examples and Review
  guide tabs, unsaved-answer preservation, readable reasons, required subtype
  and missing-information inputs, keyboard operation, automated accessibility
  checks and no page overflow at 320px and 390px. The profile-specific browser
  scenario uses synthetic DTOs; the service/database test exercises actual
  profile creation, import, assignment and submission. Neither claims a live
  Supabase walkthrough or a complete manual assistive-technology audit.
- Initial regression runs exposed stale schema-marker expectations and one old
  reason-label expectation. These were corrected; the final runs above passed.
  Independent review also found the third-packet detection gap and inconsistent
  legacy reason validation; both are fixed and covered by negative tests.

The full formatting command reports only unchanged supplied material:
`tests/handoff/fixtures/v7/{SYNTHETIC_PILOT_UNITS_v7,VOCABULARY_CONTRACT_v7}.json`,
`tests/handoff/{v7-dry-run,v7-mutation,v7}.mjs`, and eight files in
`docs/design_v7/`: `APP_MAPPING_v7.md`, `CHANGELIST_v7.md`,
`EXPORT_TO_PERFORMANCE_SPEC_v7.md`, `PENDING_DECISIONS_v7.md`,
`PILOT_ACCEPTANCE_CHECKLIST_v7.md`, `REVIEW_RUBRIC_v7_supplied.md`,
`REVIEW_RUBRIC_v7.md`, and `SCHEMA_API_CONTRACT_v7.md`.

## Release boundary

No schema was applied to a shared database, no real account or response was
changed, and no deployment, gate approval, freeze or invitation was performed.
Formal operations remain unavailable in the web application. Review, remaining
scientific approvals, native/live checks and an explicit deployment plan are
still required before formal use.
