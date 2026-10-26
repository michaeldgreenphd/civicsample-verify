# New-project schema installation: 2026-10-26

Scope: the investigator authorized only the schema installation in the separate
preparation project `jsuthraousvtgjpgixdz`. No account provisioning, study import,
approval, freeze, opening, invitation or web deployment was included. This report
contains aggregates and generalized commands only; configuration and detailed
execution records remain outside Git in owner-only files.

## Reviewed source and local verification

The applied source was `a65cd587ffec10142423a1f2693e8078ab5074d8` (PR #38,
stacked on PR #37). Independent Codex review completed without findings on both
heads. PR #38's [pull-request run](https://github.com/michaeldgreenphd/civicsample-verify/actions/runs/40352667873)
and [push run](https://github.com/michaeldgreenphd/civicsample-verify/actions/runs/40352352859)
passed all three jobs: web, analysis and PostgreSQL 16.

- `VERIFY_ANALYSIS_PYTHON=<existing analysis virtualenv>/bin/python npm run check`:
  **394 passed, 0 failed, 39 skipped, 1 existing TODO**. TypeScript, lint, fixture
  and v4/v5/v7 leakage scans passed. The skips are local native-database and
  live-user checks; they are not passes.
- `npm run build`: **PASS**, 41 allowed SQL inputs; no local runtime files in
  production traces.
- `npm run test:e2e:production`: **17 passed**, synthetic in-memory data. The
  initial restricted invocation could not bind the local port; the permitted
  loopback invocation passed.
- Targeted Prettier for the six changed files and `git diff --check
01691a2..HEAD`: **PASS**.

## Live schema operation

Before writing, the exact destination, reviewed plan digest and SQL manifest
were rechecked. Verified TLS and a read-only transaction showed zero application
objects, Auth users and Storage objects; sign-ups were disabled. The new server
reports PostgreSQL **17.11**, distinct from the hosted PostgreSQL 16 test service.

The existing guarded installer was executed with the private configuration:

```sh
VERIFY_SUPABASE_ADMIN_APPLY=1 node scripts/supabase-admin.mjs apply-schema \
  --config <private-config> --apply \
  --confirm-project jsuthraousvtgjpgixdz \
  --plan-sha256 <reviewed-plan-digest>
```

Observed result: **39 SQL inputs applied and one compatibility preflight run**.
All 39 expected version markers are present, ending at
`8.1.4-prepared-sample-intake` (migration 0039). A read-only resume calculation
finds no pending schema file. No second apply was needed.

## Post-installation checks

| Check                                                                                          | Observed result                                           |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| TLS validation and read-only inspection                                                        | PASS                                                      |
| Exact migration lineage and expected final version                                             | PASS                                                      |
| Auth users, application users and reviewer enrollments                                         | All zero                                                  |
| Designs, mappings, training units, queue assignments and judgments                             | All zero                                                  |
| Adjudications, gate approvals, freezes and phase events                                        | All zero                                                  |
| Intake receipts, reviewer-guide bindings and probability bindings                              | All zero                                                  |
| Mapping-workflow tables with RLS enabled                                                       | 20 of 20                                                  |
| Anonymous grants on those tables                                                               | Zero                                                      |
| Direct INSERT/UPDATE/DELETE/TRUNCATE grants for authenticated or service roles on those tables | Zero                                                      |
| Intake RPC execution privileges                                                                | Authenticated only; denied to anonymous and service roles |
| Anonymous HTTP reads of units, judgments, intake receipts and probability bindings             | All four refused with HTTP 401                            |
| Public sign-ups                                                                                | Disabled                                                  |
| Investigator MFA requirement                                                                   | Still enabled                                             |

All ten automated post-installation checks passed. The first local reporting
wrapper incorrectly expected nine checks and labelled the aggregate FAIL even
though each check was true. Its expected-check list was corrected and the entire
read-only verification reran successfully; no database change was made to obtain
that result.

## Limits and next acceptance work

This establishes schema installation, catalog permissions and anonymous access
denials on the new Supabase project. It does **not** establish authenticated
reviewer isolation, investigator/observer permissions, adjudication, account-lock
behavior, live sample intake, exports or restoration there. Those checks still
need separately provisioned identities and authorized test data. No clinical
records or accounts exist in this destination yet.

The current practice deployment and its records were not changed. Existing
password preservation, the requested read-only investigator restriction and
isolated pilot identities must be covered by the next account plan. Clinical
opening and scientific approvals remain separate investigator actions.
