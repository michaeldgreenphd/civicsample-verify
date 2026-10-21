# CivicSample Verify readiness — 2026-10-21

**Working local synthetic pilot; not ready for formal clinical review. The complete requested production platform is not finished.** The application supports a ten-case independent-review/adjudication/lock/export path. Remaining formal and infrastructure integration work is listed explicitly below and in `docs/OPEN_QUESTIONS.md`. No actual records were imported, no physicians were invited, and no production service was deployed.

## Executed verification

Environment: macOS; Node.js 26.8.1; Python 3.13.4; PGlite 0.3.16 (PostgreSQL 17.5 WebAssembly). Dependency lockfiles and pinned Python requirements are committed. CI targets Node 22 and Python 3.12; hosted CI results must be checked separately.

| Exact command                                                                       | Observed result                                                                                                 |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `VERIFY_ANALYSIS_PYTHON=/private/tmp/verify-analysis-venv/bin/python npm run check` | PASS: TypeScript, ESLint, 20 Node tests, source/index sensitive-fixture scan; no skipped tests                  |
| `/private/tmp/verify-analysis-venv/bin/python -m pytest -q analysis`                | PASS: 86 tests                                                                                                  |
| `npm run test:handoff`                                                              | PASS: 164/164 v2; 262/262 v3; 262/262 v3-on-v4; 356/356 v4; audit probe exposed 2/2 under v3 and 0/2 after 0003 |
| `NEXT_TELEMETRY_DISABLED=1 npm run build`                                           | PASS: optimized Next.js build; explicit SQL file tracing, no runtime-secret/data paths in traced manifests      |
| `npm run test:e2e`                                                                  | PASS: one full four-role served-browser scenario                                                                |
| `npm run test:e2e:production`                                                       | PASS: same scenario against optimized build, 4.9 seconds test time                                              |
| `npm audit --audit-level=high`                                                      | PASS: zero reported vulnerabilities                                                                             |
| `git diff --check`                                                                  | PASS                                                                                                            |

The `/private/tmp` Python path is the temporary build environment, not a runtime dependency or private study path. To reproduce, create a virtual environment, install `analysis/requirements.txt`, and set `VERIFY_ANALYSIS_PYTHON` to its interpreter. Omitting that variable explicitly skips the cross-language test. Database regression steps and Node test cases are different units; their counts must not be added together as a claim of clinical validity.

## Acceptance matrix

PASS means observed in the stated local synthetic environment. FAIL means requested implementation remains incomplete. NOT TESTED means execution/approval evidence is unavailable; BLOCKED explains why and never means PASS.

| Acceptance gate                                                          | Status     | Evidence / limit                                                                                                                  |
| ------------------------------------------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Inspect supplied v4 archive and source contract                          | PASS       | Archive inspected outside repository; original SQL byte checksums tested                                                          |
| Public repository contains only reviewed code/docs/synthetic fixtures    | PASS       | Source plus Git-index scanner, injected leak tests and staged-diff review; heuristic, not proof for arbitrary prose               |
| Fresh local application and four role accounts                           | PASS       | README/setup, generated local password, production-browser sign-in                                                                |
| Persistent drafts and restart behavior                                   | PASS       | Separate-process on-disk database test                                                                                            |
| Same ten pilot cases assigned independently                              | PASS       | Two review accounts; ten case assignments each; two cases have two determination levels                                           |
| Two-step trial evidence remains withheld until locked Step 1             | PASS       | API/database negative tests and browser requests                                                                                  |
| Required decision, rationale, uncertainty and structured context         | PASS       | Explicit-selection UI; server/database validation; malformed-context tests                                                        |
| Final responses cannot be overwritten                                    | PASS       | Database/service tests and HTTP resubmission denial                                                                               |
| Explicit auditable amendments preserve originals                         | PASS       | Authorized separate draft scopes, append-only versions, pre-close-only authorization tests                                        |
| Reviewer cannot see other reviewer's draft/response/status/audit         | PASS       | Own-row RLS/RPC tests; isolated browser requests; audit endpoints unavailable                                                     |
| Unassigned/nonexistent case access denied                                | PASS       | Database/API checks; same public 404                                                                                              |
| No classifier prediction or design fields in reviewer/adjudicator DTOs   | PASS       | Explicit allowlists and negative response checks; no actual prediction data in pilot                                              |
| Investigator sees completion only during independent review              | PASS       | Database RPC and browser checks; amendment records contain reason, not judgment payload                                           |
| Adjudication requires both reviewers and investigator authorization      | PASS       | Database/server and served-browser lifecycle                                                                                      |
| Separate adjudication, uncertainty and unresolved state preserved        | PASS       | Regression tests; null unresolved reference distinct from explicit insufficient-information decision                              |
| Lock prevents further mutations and export verifies snapshot             | PASS       | Database immutability/tamper tests; production browser lock/export                                                                |
| No implicit scientific version choice                                    | PASS       | Initial version PENDING; proposal-only configuration                                                                              |
| Explicit sample/rubric/version/reviewer/security/pilot gates             | PASS       | Investigator screen; real activation denied in code; coverage warning unresolved                                                  |
| Supplied development/held-out/freeze invariants                          | PASS       | Historical synthetic v4 database suite; not an actual sample import                                                               |
| Pilot/development/calibration excluded from performance analysis         | PASS       | Pilot archive ineligible; synthetic v4 validator/writer refusal tests                                                             |
| Paired classifier metrics use the same adjudicated units                 | PASS       | Synthetic Python tests and TypeScript-to-Python round trip                                                                        |
| Probability/weight, missingness and indeterminate distinctions           | PASS       | Synthetic design validation and zero/unknown/missing regression tests                                                             |
| Actual SQL view → v4 writer → analysis integration                       | NOT TESTED | BLOCKED pending formal adapter; fixture → writer → analysis passes                                                                |
| Real Supabase invited authentication, JWT, MFA and direct RLS/API access | FAIL       | Local authentication is implemented; production adapter/invitation UI remains unimplemented. No Supabase staging service supplied |
| Actual PostgreSQL 16 deployment/RLS suite                                | NOT TESTED | BLOCKED: no PostgreSQL/Docker executable or provisioned test service available                                                    |
| General project/campaign/case/rubric authoring                           | FAIL       | Single seeded pilot only; formal administration interface remains incomplete                                                      |
| Formal sample import/freeze/reference workflow in web app                | FAIL       | Original schema retained but production formal adapter/screens unimplemented; real activation disabled                            |
| Module B remains distinct and unapproved                                 | PASS       | Separate proposed entry point/schema; no mixing into pilot or Module A exports                                                    |
| Full Module B application workflow                                       | NOT TESTED | Not activated or implemented in UI; supplied synthetic schema regressions only                                                    |
| Automated accessibility                                                  | PASS       | Axe WCAG 2 A/AA and 2.1 AA on reviewer form; contrast issues corrected                                                            |
| 390px responsive layout and keyboard focus                               | PASS       | Production-browser no-horizontal-overflow check, keyboard focus and screenshots                                                   |
| Full manual screen-reader/keyboard/accessibility audit                   | NOT TESTED | Automated checks are not a complete accessibility audit                                                                           |
| Performance/load/backup/restore/retention                                | NOT TESTED | Single-user functional timing only; production operational tests outstanding                                                      |
| Investigator pilot acceptance and formal scientific approval             | NOT TESTED | Requires investigator review/signature; software has not supplied this approval                                                   |

## Browser evidence

The browser test uses independent contexts for investigator, reviewer A, reviewer B and adjudicator. It operates reviewer and adjudicator forms and investigator transitions in the UI, completes remaining fictional cases through authenticated HTTP requests, then verifies export separation. It checks prohibited routes, cross-origin requests, hidden trial evidence, invalid input, resubmission denial and post-close writes. This is a combined UI/API scenario, not a claim that every form permutation was manually exercised.

- [Reviewer desktop](docs/screenshots/reviewer-desktop.png)
- [Investigator readiness](docs/screenshots/investigator-desktop.png)
- [Adjudicator desktop](docs/screenshots/adjudicator-desktop.png)
- [Reviewer at 390px](docs/screenshots/reviewer-mobile.png)

Adjudication edits remain view-local until submitted; the interface states this. Local authentication uses one generated investigator-operated pilot password and synthetic identities. It must not be exposed through a public tunnel. The local auth shim supplies test claims and does not test actual JWT verification or MFA.

See `docs/DEPLOYMENT.md` for the invited-team staging/deployment sequence. No production activation or real-data transfer is authorized by these results.
