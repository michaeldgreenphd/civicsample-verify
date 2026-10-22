# Staging-readiness verification — 2026-10-22

Tested implementation: `12be20a0b1cbfac2e5acbcd3e38ff5ccff3e0216`. The documentation commit may follow it. Source, fixtures and reports are synthetic/generalized; no private roster, source rows or transfer digests are included.

## Executed locally

| Command                                                        | Result                                                     | Scope                                                                                                                                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VERIFY_ANALYSIS_PYTHON="$PWD/.venv/bin/python" npm run check` | PASS: 106 passed, 1 skipped, 0 failed                      | TypeScript, lint, Node regressions, two cross-language export paths, source/index scanners. The skip is native PostgreSQL without a local service.                                     |
| `.venv/bin/python -m pytest -q analysis`                       | PASS: 291 tests                                            | Maintained synthetic performance validation, including removal-only labels.                                                                                                            |
| `npm run test:handoff`                                         | PASS: v2 164/164; v3 262/262; v3-on-v4 262/262; v4 356/356 | Preserved SQL/assertions on PGlite. Audit probe: 2 exposed synthetic decisions before 0003, 0 after.                                                                                   |
| `python -m pytest -q validation`                               | PASS: 108 tests                                            | Original supplied Python suite in an isolated external copy, using the application's virtual-environment interpreter. This repository maintains the strengthened suite in `analysis/`. |
| `python3 tools/check_public_repo_leakage_v4.py --tree`         | PASS: zero violations                                      | Adapted upstream v2/v3/v4 rules plus Git-index blobs and the existing JS scanner. Ignored runtime exclusions and exact fixture exceptions are documented in source.                    |
| `npm run build`                                                | PASS                                                       | Optimized Next.js build; 6 trace manifests, 12 reviewed SQL inputs; no local runtime files bundled.                                                                                    |
| `npm run test:e2e:production`                                  | PASS: 2 scenarios, 6.8 seconds                             | Ten-case synthetic workflow and canonical two-step authoring. Combined browser/API run, not a manual physician acceptance session.                                                     |
| `npm run format:check`                                         | PASS                                                       | Prettier.                                                                                                                                                                              |
| `git diff --check`                                             | PASS                                                       | Whitespace.                                                                                                                                                                            |
| `npm run test:handoff:postgres`                                | BLOCKED locally                                            | No native PostgreSQL service. Hosted CI is wired to require it and upload the sanitized report.                                                                                        |
| `npm run test:supabase:staging`                                | BLOCKED                                                    | User confirmed no staging project; setup deferred until after local testing. No requests or mutations performed.                                                                       |

Native hosted verification: **PENDING for this branch**. Do not infer it from a previous branch's passing checks. Full Supabase acceptance remains UNTESTED regardless of any local result.

## Additional verification

- New 0010 restriction exercised through Module A legacy/v3 and Module B RPCs, direct inserts, spoofed deciders, and valid independent adjudicators. Persistent upgrade ran through `getDb()` twice and retained existing pilot judgments, locked references, snapshots and audit hashes. The migration only restricts new writes; it does not rewrite existing export functions or their frozen format identifier.
- Five permitted private transfer inputs passed read-only hash-first validation, including each explicitly selected Tier version. This is **not a database import dry run**: zero database writes, no activation, no prediction load and no approval changes. Detailed private-source values are intentionally absent here.
- The account-plan tests validate unique single-role identities and staging-only declarations. No named accounts, credentials or invitations were created. The Supabase preflight has eight mocked tests; a mock is not a real JWT integration test.
- The source scanner tests include staged-but-cleaned/deleted secrets and real-format private identifier families. Manual inspection remains required; a heuristic scan is not proof against arbitrary private prose.
- Original schema and migrations 0002/0003/0008/0009 remain unchanged. Supplied SQL suites remain unchanged; the native runner adapts only driver imports in temporary copies.

## Pilot and analysis separation

The served-browser scenario completes the ten SYN cases using separate synthetic reviewer identities operated by the test harness, adjudicates disagreements under a separate account, locks and checks exports. The investigators have not yet performed their own acceptance session. The primary performance script refuses SYN records. A distinct HO4-TESTFX formal-shaped synthetic bundle exercises database export through Python analysis, with preserved sampling/provenance checks. Neither set is clinical evidence.

The requested three jointly discussed examples remain pending. They will be calibration/development records, permanently excluded from the independent validation sample and performance exports.

## Remaining acceptance work

Use [the completed engineering checklist](../PILOT_ACCEPTANCE_CHECKLIST_v4.md). Supabase project creation, real roster/MFA sessions, full deployed RLS/RPC/browser testing, manual timing/accessibility review, backup restoration, calibration examples and scientific approvals remain outstanding. Production activation, real sample import, invitations and freeze remain disabled. The development registry's historical activation prerequisite has not been bypassed.
