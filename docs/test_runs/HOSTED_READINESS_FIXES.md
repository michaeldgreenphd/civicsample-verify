# Hosted workflow recovery and preparation status

Executed 25 October 2026 on `codex/hosted-readiness-fixes`, based on
`cab0777bf77cda0b2d9cbdcee0f06c08ba3cd1ac` (PR #26). These are local results
for the integrated changes. The new published head must pass hosted CI
separately; the successful PostgreSQL job on the base is not a result for this
head.

## Changes and review findings

The still-applicable PR #7 findings are addressed in this successor branch:

- Web startup requires an independently approved staging project and HTTPS
  outside explicit loopback hosts.
- API activity can refresh a session. Refresh-only and expired-access logout
  confirm revocation; temporary Auth failures do not discard usable tokens or
  report a successful logout. Already-invalid credentials are cleared locally
  without claiming global revocation. Rotated cookies survive downstream errors.
- Staging test cleanup logs out its own session only. Returning-investigator
  TOTP factor selection was already server-controlled; its regression remains.
- Account reconciliation validates the existing active identity, role and
  immutable pilot flag. Only an explicitly reviewed display name may change.
  Partial creation can resume without replacing credentials or historical rows.
- Interrupted mapping-confirmation imports resume only missing synthetic
  fixtures after checking every saved payload. Reviewer assignment retains
  existing slots and seed, excludes inactive accounts, and fills missing work.
  The UI exposes both retries and no longer calls a single queue complete.

The investigator also has a read-only preparation summary. Its download is
allowlisted status information, not study data or an approval record. Counts,
completed practice and returned gate approvals cannot certify the release.
Reviewer and adjudicator workspaces do not show this report.

No migration or scientific rule changed. No remote service, operational
record, password, sample, approval, freeze or invitation changed.

## Observed checks

`<analysis-python>` is an existing local virtual environment with the analysis
requirements installed, outside this repository.

| Command or check                                         | Result                                                                                                                                                            |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VERIFY_ANALYSIS_PYTHON=<analysis-python> npm run check` | PASS: typecheck, lint, 419 tests (381 passed, 0 failed, 37 skipped, 1 TODO), fixture scan and v4/v5/v7 leakage scans. Each leakage scan reported zero violations. |
| `npm run build`                                          | PASS: 7 manifests, 39 SQL inputs, no local runtime files in production traces.                                                                                    |
| `npm run test:e2e:production`                            | PASS: 15/15 locally served production-browser scenarios, including failed/retried logout and exit from an expired workspace.                                      |
| Changed-file Prettier check                              | PASS. Preserved handoff files were not reformatted; the previously documented whole-tree format failure is unchanged.                                             |
| `git diff --check`                                       | PASS.                                                                                                                                                             |
| Focused earlier-review regression run                    | PASS: 30/30 across `mu7-gates-v8-1`, `mu7-live-phases`, `supabase-pilot-tools`, and `mu7-lifecycle`.                                                              |
| Native PostgreSQL locally                                | BLOCKED: no native test service configured. Hosted PostgreSQL 16 CI remains required.                                                                             |
| Live Supabase / Render verification                      | NOT TESTED for this increment. No remote request or deployment was made.                                                                                          |

The 37 skips cover unavailable native PostgreSQL and live-staging checks. The
existing TODO is the separately proposed cross-design guard. Neither is counted
as passing. The full check includes the existing database-to-analysis roundtrips;
the standalone Python suite and unchanged supplied handoff suites were not
repeated locally in this increment and remain hosted CI checks.

Independent review also caught a stale-workspace logout edge case. A new API regression reproduced the 401 refusal before the fix. Definitively invalid credentials now clear local sign-in state without claiming global revocation; temporary service failures remain retryable. The follow-up Auth/startup suite passed 19/19.

The first new browser run failed because a generic alert selector also matched
Next.js's route announcer. Scoping the assertion to the application main region
fixed the test; no product behavior or error check was removed. The final run
passed all 15 scenarios after the logout follow-up. Browser coverage includes interrupted import and
assignment recovery, the status download, role-specific visibility, no page
overflow at 320/390 pixels and an automated WCAG A/AA scan of the new panel.
Auth and PostgREST recovery tests use an in-process synthetic gateway; they are
not evidence of live Supabase behavior. Manual assistive-technology testing was
not performed.

Reviewed synthetic screenshots:

- [Desktop preparation view](../screenshots/hosted-preparation-desktop.png)
- [Mobile preparation view](../screenshots/hosted-preparation-mobile.png)

## Compatibility and remaining live check

Regenerate the private admin plan before any authorized account apply: it now
hashes the exact display-name bytes and describes reconciliation. Existing
passwords and account locks stay intact. No schema apply is required for these
fixes.

The renamed refresh cookie prevents old and new path-scoped cookies from
shadowing one another. Startup migrates the legacy cookie. An already-open
legacy tab may need one reload after deployment when its access token expires;
the startup request can recover the existing session without a password reset.

After code review and a separately authorized staging deployment, verify session
renewal, failed/retried logout, account locks and reviewer isolation using
synthetic accounts with real JWTs. Use a disposable campaign for interruption
tests. Current practice records must not be reset to exercise recovery. Formal
opening still requires its sample, scientific decisions and release checks.

## Older thread reconciliation

Nine PR #11 threads already had fixes in its current head `e245402` (ancestor
commits `4f8c180`, `933bb25`, `7bf8e3e`, `f02de54`). The remaining PR #9 thread
had its exclusive adjudication lock in ancestor `65a7697` of head `2a45092`.
Those threads were closed after code and regression verification. PR #7's new
fixes live in this successor branch; its earlier head is not made safe by a
comment or by resolving a thread.
