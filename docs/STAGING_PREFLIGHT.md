# Staging preparation and calibration

This branch adds read-only transfer validation, an offline account plan, removal-only analysis interpretation, and native PostgreSQL regression execution. It does not implement real account provisioning or authorize a formal campaign.

## Three shared examples

The investigator has requested three examples discussed jointly before independent review. Treat these as rubric calibration: register their frame units in the development/exclusion ledger, keep their responses outside formal outcomes, and check the remaining proposed sample against that ledger before freeze. The examples have not yet been supplied. Do not substitute three held-out cases or silently reduce the approved sample. Synthetic interface testing remains a separate ten-case pilot.

## Private inputs

Keep all transfer files, account identities, approvals, keys and results outside every public repository. Do not paste secrets into a chat. The transfer manifest supplies expected SHA-256 values; the validator refuses a mismatch before parsing. It does not discover or trust an adjacent digest automatically.

```sh
npm run staging:preflight -- --environment staging --kind development \
  --file /absolute/private/development.csv --sha256 EXPECTED_SHA256 --expected-rows EXPECTED_COUNT
```

Other kinds are `heldout`, `predictions`, and `module-b`. A held-out preflight additionally requires `--weight-column`, `--development-file`, `--development-sha256`, and `--development-rows`. Prediction validation also requires `--sample-file`, `--sample-sha256`, `--sample-rows`, `--sample-weight-column`, and the explicitly selected `--tier1-version v1.1` or `v1.2`. Module B requires `--condition-rows`, `--trial-rows`, and `--weight-column`. Counts and weight-column names must come from the inspected transfer specification; they are not guessed by this tool.

These commands read files in memory and perform **zero database writes**. PASS means hash/schema/provenance preflight only. It does not mean database import dry run, scientific approval, prediction freeze, or `rpc_verify_frozen_predictions_v4` execution. Selection probability serialization may differ only by relative serialization tolerance of 1e-12; original values are never rewritten. String metadata remain exact.

The preserved migration requires active design v4 before writing the development registry. This conflicts with the current no-activation instruction. Do not bypass it; actual import remains blocked pending investigator reconciliation. Neither proposed prediction file may be loaded while Tier 1 approval remains pending.

## Five-account staging plan

Create two private JSON files with mode 600 outside Git repositories. Config fields are `environment` (`staging`), `stagingProjectRef`, `productionProjectRef` (explicit `null` if no production project exists), and `projectUrl` (the exact HTTPS staging origin). The roster is an array of five objects with `email`, `displayName`, and one `role`: two `INVESTIGATOR`, two `REVIEWER`, one `ADJUDICATOR`. Do not commit the actual roster. Formal roster accounts must be separate from investigator-operated pilot accounts.

```sh
npm run staging:accounts -- --config /absolute/private/staging-config.json \
  --roster /absolute/private/staging-roster.json --dry-run
```

The plan validates declarations locally, omits identities from output, and reports that remote provisioning is blocked. It does not create credentials, send invitations, contact Supabase, or enroll reviewers. `--apply` refuses. Real Auth identity verification, application-user linkage, MFA and RLS tests are still required. The existing localhost access sheet is for synthetic testing only.

## Native regression evidence

```sh
VERIFY_PG_REQUIRE=1 npm run test:handoff:postgres -- --report docs/test_runs/native-handoff.json
```

Set `VERIFY_PG_TEST_URL` to a disposable development PostgreSQL 16 service with database-creation privileges. The harness rejects Supabase origins, creates fresh owned databases, replaces only the preserved suites' driver imports, and checks the source database's table catalog before and after. It never applies the test auth shim to Supabase. CI uploads the sanitized report. Missing configuration is BLOCKED and fails when `VERIFY_PG_REQUIRE=1`.

PGlite, native PostgreSQL with test claims, and Supabase with real JWTs are three different verification environments. A PASS in one must never fill another's acceptance box.

## Future read-only Supabase probes

The investigator chose to create staging after local testing. Until then, `npm run test:supabase:staging` reports BLOCKED without making requests. Once accounts, MFA and synthetic positive controls exist, use `-- --config /absolute/private/staging-probes.json`. The private JSON contains `project` (the staging declaration above), `publicAnonKey`, five `accounts` in investigator/investigator/reviewer/reviewer/adjudicator order, and `fixtures`. Each account has `role`, `authUserId`, `appUserId`, `accessToken`; no service key is accepted. Optional synthetic positive controls are `predictionCaseId`, `reviewerAReviewId`, `reviewerBReviewId`, `auditId`, `developmentCaseId`, `calibrationCaseId`, `pilotCaseId`.

The runner verifies existing sessions through Auth and `rpc_whoami`, then limited read-isolation probes. It refuses redirects and never prints remote payloads or credentials. Missing positive controls are UNTESTED, never a vacuous PASS. Full Supabase acceptance always remains UNTESTED: write denial, all RPCs/views/routes, MFA enrollment, token refresh/revocation and browser deployment still require a separate integration run. It never signs in, refreshes tokens, provisions users or seeds fixtures.
