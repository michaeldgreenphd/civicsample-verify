# Prepared-sample intake verification

Scope: additive migration 0039 and the investigator-only preparation route. This report contains no study identifiers, packet content, source hashes, credentials or reviewer responses.

## Observed checks

- `VERIFY_ANALYSIS_PYTHON=<existing analysis virtualenv>/bin/python npm run check`: **391 passed, 0 failed, 39 skipped, 1 existing TODO**. TypeScript, lint, fixture and v4/v5/v7 leakage scans pass. The configured interpreter contains the pinned analysis dependencies. The first attempt used an incomplete interpreter and exposed outdated migration-version expectations; both were corrected before this full rerun.
- `node --import tsx --test tests/formal-intake.test.ts`: **3 passed**, two native PostgreSQL tests skipped locally. Coverage includes atomic rollback on a bad last packet, manifest/probability/queue/profile mismatch, per-role and MFA refusal, empty-target enforcement, safe retry, inaccessible unassigned units, file permissions/checksums/symlinks, redacted errors and refusal of freeze. The native tests add simultaneous identical requests and one-receipt enforcement.
- `MU7_ALLOW_NO_DB_BUNDLE=1 MU8_ALLOW_NO_DB_BUNDLE=1 <analysis virtualenv>/bin/python -m pytest -q analysis`: **592 passed, 39 skipped**. Skips require external or database-written fixtures. The full Node check separately writes the v7/v8/v8.1/v8.3 synthetic bundles and runs the database-to-analysis round trips.
- `npm run test:handoff`: **PASS with previously documented exceptions** (v4-on-v5 version list; v5.1-on-app version list; v7 version list and stricter adjudicator check). The final chain, including 0039, remains 360/362; no new exception is accepted.
- `npm run build`: **PASS**, 41 allowed SQL inputs, no runtime/private files in the production traces.
- `npm run test:e2e:production`: **17 passed**. The intake panel test uses a mocked synthetic plan/response with the real served UI; database behavior is tested separately. Includes attestation, retry/error state, occupied/closed refusal, responsive widths 1280/390/320 and automated WCAG A/AA checks. Screenshots: ignored `test-results/sample-intake-mobile.png` and `sample-intake-desktop.png`.
- `npm run format:check`: **existing failure in 13 unchanged vendored handoff/design files**. Changed application, test and documentation files pass targeted Prettier checks; supplied files are preserved.
- `git diff --check`: **PASS**.
- Actual private candidate rehearsal: 100 mappings and 200 planned queue positions verified in two disposable in-memory databases, with the revision-4 guide and probability binding. Zero remote requests, approvals, freezes or assigned queues. No private input was copied into this repository.
- Read-only destination inspection: both existing environments contain a practice design; the new intake refuses them. No operational record was changed.

Native PostgreSQL is **BLOCKED locally** (no PostgreSQL 16 or Docker). Both new tests are registered in the hosted PostgreSQL 16 CI job. Inspect that exact PR head's job result; PGlite is not a native or Supabase result.

## Remaining release acceptance

Live Supabase application of 0039, real-JWT intake, the exact hosted build, formal freeze/opening, operational exports and restoration of the final destination are **NOT TESTED** by this increment. Scientific approvals remain investigator actions. The current practice site is not replaced.
