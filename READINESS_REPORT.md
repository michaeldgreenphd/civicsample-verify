# CivicSample Verify readiness — 2026-10-21

**Working local synthetic pilot; not ready for formal clinical review. The complete requested production platform is not finished.** The application supports a ten-case independent-review/adjudication/lock/export path. Remaining formal and infrastructure integration work is listed explicitly below and in `docs/OPEN_QUESTIONS.md`. No actual records were imported, no physicians were invited, and no production service was deployed.

## Executed verification

Environment: macOS; Node.js 26.8.1; Python 3.13.4; PGlite 0.3.16 (PostgreSQL 17.5 WebAssembly). Dependency lockfiles and pinned Python requirements are committed. CI targets Node 22 and Python 3.12; hosted CI results must be checked separately.

| Exact command                                                                       | Observed result                                                                                                          |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `VERIFY_ANALYSIS_PYTHON=/private/tmp/verify-analysis-venv/bin/python npm run check` | PASS: TypeScript, ESLint, 53 Node tests, source/index sensitive-fixture scan; no skipped tests                           |
| `/private/tmp/verify-analysis-venv/bin/python -m pytest -q analysis`                | PASS: 274 tests                                                                                                          |
| `npm run test:handoff`                                                              | PASS: 164/164 v2; 262/262 v3; 262/262 v3-on-v4; 356/356 v4; audit probe exposed 2/2 under v3 and 0/2 after 0003          |
| `npm run build`                                                                     | PASS: optimized Next.js build; eight required SQL inputs retained; runtime-file exclusion and build trace allowlist pass |
| `npm run test:e2e`                                                                  | PASS on initial build: one full four-role served-browser scenario; review fixes rechecked using production command below |
| `npm run test:e2e:production`                                                       | PASS: same scenario against optimized build, 5.1 seconds test time                                                       |
| `npm audit --audit-level=high`                                                      | PASS: zero reported vulnerabilities                                                                                      |
| `git diff --check`                                                                  | PASS                                                                                                                     |

The `/private/tmp` Python path is the temporary build environment, not a runtime dependency or private study path. To reproduce, create a virtual environment, install `analysis/requirements.txt`, and set `VERIFY_ANALYSIS_PYTHON` to its interpreter. Omitting that variable explicitly skips the cross-language test. Database regression steps and Node test cases are different units; their counts must not be added together as a claim of clinical validity.

## Acceptance matrix

PASS means observed in the stated local synthetic environment. FAIL means requested implementation remains incomplete. NOT TESTED means execution/approval evidence is unavailable; BLOCKED explains why and never means PASS.

| Acceptance gate                                                          | Status     | Evidence / limit                                                                                                                                         |
| ------------------------------------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inspect supplied v4 archive and source contract                          | PASS       | Archive inspected outside repository; original SQL byte checksums tested                                                                                 |
| Public repository contains only reviewed code/docs/synthetic fixtures    | PASS       | Source plus Git-index scanner, injected leak tests and staged-diff review; heuristic, not proof for arbitrary prose                                      |
| Fresh local application and four role accounts                           | PASS       | README/setup, generated local password, production-browser sign-in                                                                                       |
| Persistent drafts and restart behavior                                   | PASS       | Separate-process on-disk database test                                                                                                                   |
| Same ten pilot cases assigned independently                              | PASS       | Two review accounts; ten case assignments each; two cases have two determination levels                                                                  |
| Two-step trial evidence remains withheld until locked Step 1             | PASS       | API/database negative tests and browser requests                                                                                                         |
| Required decision, rationale, uncertainty and structured context         | PASS       | Explicit-selection UI; server/database validation; malformed-context tests                                                                               |
| Final responses cannot be overwritten                                    | PASS       | Database/service tests and HTTP resubmission denial                                                                                                      |
| Explicit auditable amendments preserve originals                         | PASS       | Append-only versions and scoped drafts; Step 1 amendments denied; legacy violations block reference use                                                  |
| Reviewer cannot see other reviewer's draft/response/status/audit         | PASS       | Own-row RLS/RPC tests; isolated browser requests; audit endpoints unavailable                                                                            |
| Unassigned/nonexistent case access denied                                | PASS       | Database/API checks; same public 404                                                                                                                     |
| No classifier prediction or design fields in reviewer/adjudicator DTOs   | PASS       | Explicit allowlists and negative response checks; no actual prediction data in pilot                                                                     |
| Investigator sees completion only during independent review              | PASS       | Database RPC and browser checks; amendment records contain reason, not judgment payload                                                                  |
| Adjudication requires both reviewers and investigator authorization      | PASS       | Database/server and served-browser lifecycle                                                                                                             |
| Separate adjudication, uncertainty and unresolved state preserved        | PASS       | Regression tests; null unresolved reference distinct from explicit insufficient-information decision                                                     |
| Lock prevents further mutations and export verifies snapshot             | PASS       | Database immutability/tamper tests; atomic snapshot verification and zero-answer rejection; stable archive bytes                                         |
| No implicit scientific version choice                                    | PASS       | Initial version PENDING; proposal-only configuration                                                                                                     |
| Explicit sample/rubric/version/reviewer/security/pilot gates             | PASS       | Investigator screen; real activation denied in code; coverage warning unresolved                                                                         |
| Supplied development/held-out/freeze invariants                          | PASS       | Historical synthetic v4 database suite; not an actual sample import                                                                                      |
| Pilot/development/calibration excluded from performance analysis         | PASS       | Pilot archive ineligible; synthetic v4 validator/writer refusal tests                                                                                    |
| Paired classifier metrics use the same adjudicated units                 | PASS       | Synthetic Python tests and TypeScript-to-Python round trip                                                                                               |
| Probability/weight, missingness and indeterminate distinctions           | PASS       | Synthetic design validation and zero/unknown/missing regression tests                                                                                    |
| Actual SQL view → v4 writer → analysis integration                       | NOT TESTED | BLOCKED pending formal adapter; fixture → writer → analysis passes                                                                                       |
| Real Supabase invited authentication, JWT, MFA and direct RLS/API access | FAIL       | Local authentication is implemented; production adapter/invitation UI remains unimplemented. No Supabase staging service supplied                        |
| Actual PostgreSQL 16 deployment/RLS suite                                | NOT TESTED | BLOCKED: no PostgreSQL/Docker executable or provisioned test service; multi-session import/freeze/reference-lock/withdrawal coordination also NOT TESTED |
| General project/campaign/case/rubric authoring                           | FAIL       | Single seeded pilot only; formal administration interface remains incomplete                                                                             |
| Formal sample import/freeze/reference workflow in web app                | FAIL       | Original schema retained but production formal adapter/screens unimplemented; real activation disabled                                                   |
| Module B remains distinct and unapproved                                 | PASS       | Separate proposed entry point/schema; repeat final submissions denied; no mixing into pilot or Module A exports                                          |
| Full Module B application workflow                                       | NOT TESTED | Not activated or implemented in UI; supplied schema and new finality/upgrade regressions only                                                            |
| Automated accessibility                                                  | PASS       | Axe WCAG 2 A/AA and 2.1 AA on reviewer form; contrast issues corrected                                                                                   |
| 390px responsive layout and keyboard focus                               | PASS       | Production-browser no-horizontal-overflow check, keyboard focus and screenshots                                                                          |
| Full manual screen-reader/keyboard/accessibility audit                   | NOT TESTED | Automated checks are not a complete accessibility audit                                                                                                  |
| Performance/load/backup/restore/retention                                | NOT TESTED | Single-user functional timing only; production operational tests outstanding                                                                             |
| Investigator pilot acceptance and formal scientific approval             | NOT TESTED | Requires investigator review/signature; software has not supplied this approval                                                                          |

## Browser evidence

The browser test uses independent contexts for investigator, reviewer A, reviewer B and adjudicator. It operates reviewer and adjudicator forms and investigator transitions in the UI, completes remaining fictional cases through authenticated HTTP requests, then verifies export separation. It checks prohibited routes, cross-origin requests, hidden trial evidence, invalid input, resubmission denial, post-close writes, denied Step 1 amendment authorization, distinct context/packet-note fields and identical repeated export bytes. This is a combined UI/API scenario, not a claim that every form permutation was manually exercised.

- [Reviewer desktop](docs/screenshots/reviewer-desktop.png)
- [Investigator readiness](docs/screenshots/investigator-desktop.png)
- [Adjudicator desktop](docs/screenshots/adjudicator-desktop.png)
- [Reviewer at 390px](docs/screenshots/reviewer-mobile.png)

Adjudication edits remain view-local until submitted; the interface states this. Local authentication uses one generated investigator-operated pilot password and synthetic identities. It must not be exposed through a public tunnel. The local auth shim supplies test claims and does not test actual JWT verification or MFA.

See `docs/DEPLOYMENT.md` for the invited-team staging/deployment sequence. No production activation or real-data transfer is authorized by these results.

## Review-fix verification

Three review rounds are covered: twelve initial findings, eight follow-up findings and six further findings. The 53 Node tests include fifteen additional database/upgrade regressions from the latest round; the 274 Python tests include twenty-two additional Stage C and sampling-consistency cases. The latest database checks also cover related primary-reference selection and migration-preservation edge cases found during the internal audit. The preserved handoff suites were rerun unchanged. `npm run build` now rejects unexpected application/runtime files in deployment traces, and CI seeds a synthetic runtime-file probe before building. An unsafe trace was reproduced locally and rejected before the exclusions were applied.

Migration 0005 was tested against both fresh and persisted 0004 databases, including two subsequent process restarts. Existing responses remained unchanged. Historical packet-note defects are retained as recorded and need explicit interpretation; prior submitted Step 1 amendments block reference use pending investigator disposition. No real records or scientific approvals are implied by these checks.

Migration 0006 was tested through the real synthetic pilot-signoff, freeze, review, snapshot and reference-lock RPC sequence. Changed snapshots and zero-answer frozen levels leave no reference lock; a permitted single-reviewed, adjudicated incomplete case still locks. Predictions retained for a withdrawn case prevent freezing. Withdrawals cannot alter a locked reference, and Module B final responses cannot be resubmitted. Existing Module B revisions remain recorded; no amendment workflow is enabled for that optional module. The persistent upgrade applies exactly once across process restarts. Native multi-session PostgreSQL verification remains blocked.

The analysis validates shared case metadata before merging, preserves consistent positive case versions, enforces one case per frame unit, and requires adjudicator identity/role and valid provenance-hash syntax. Format 4.0 carries case versions only in judgments, so consistency is checked there; verification against an absent frozen-version field is not claimed. Digest syntax checks do not authenticate external artifacts absent from the bundle.

Migration 0007 rejects contradictory adjudication decisions/bases before insertion and checks existing effective primary adjudications before locking. Tests cover explicit supersession of invalid legacy records, tied timestamps, post-lock revisions that leave the primary unchanged, duplicate primary leaves, and preservation of explicit unresolved nulls. Empty and partly unanswered Module B samples cannot lock. Held-out packet versions are blocked after freeze through RPC and direct insertion, and extension freeze authorization must match all retained extension cases.

The 0007 upgrade preflight requires READ COMMITTED and serializes with reference locking. It intentionally refuses any already-locked formal v4 reference, including apparently valid references, because replacing the reference view could reinterpret a frozen export. Regression tests confirm the old schema, view, lock and adjudications remain unchanged after rollback. Such databases need explicit investigator migration review; there is no bypass or automatic repair workflow in this build. Fully completed, locked local synthetic pilots upgrade with recorded responses unchanged. Native multi-session PostgreSQL validation of this coordination is still BLOCKED.
