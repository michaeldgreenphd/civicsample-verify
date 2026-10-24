# V8 synthetic database-to-analysis verification

This increment exercises the application database and exporter with 100 fictional
mapping units and 200 initial judgments, independently for ALLOW and ONE_PER_TRIAL.
It selects neither alternative for the study and approves no scientific policy.
The estimator and rubric remain proposed. All test data are generated in disposable
databases; no research archive, private sample or operational response is read.

## Fictional identifiers and compatibility

Migration 0034 introduces `SYN-TRIAL-nnnn` identifiers for FORMAL-workflow testing
only when the recorded design version starts with `SYN-8-`. Such packets cannot
have a registry URL. A unit insertion trigger checks the recorded design; the
design-row constraint and existing packet/version equality guard check the same
boundary independently. Real-version v8 and v7 designs refuse these identifiers.
Pilot and training packet rules and the existing registry-ID/link rules remain
unchanged. This permits the unmodified database export to reach the existing
synthetic-only analysis without an ID rewrite or a bypass of its real-data refusal.

The new migration is additive. Earlier migrations, source fixtures, security
policies, gate approvals and live practice records are not rewritten. The app's
existing v7 practice remains the browser regression target; a v8 clinician-facing
release is not established by these tests.

## Scenario and checks

Each disposable database completes a 12-unit pilot, imports three fictional
read-only training examples, and then runs the synthetic formal scenario:

1. Import 56 area, 40 condition-row and four subgroup mappings on 100 fictional
   trials. Ten areas are represented, with the proposed six-and-five allocation
   used as an engineering fixture, not an approved sampling rule.
2. Satisfy the approval requirements with explicitly synthetic test records, freeze
   the independently computed hashes, assign two complete queues and open review.
3. Record 200 initial judgments with a concordant disagreement, paired Cannot tell,
   resolved discordance and unresolved discordance. Reviewers can read only their
   own 100 judgments. Export is refused before reference lock.
4. Close, snapshot, adjudicate and lock. Check 100 exported units, 200 judgments,
   the family counts, snapshot count and freeze hashes. Pilot and training records
   remain outside the exported formal dataset. Register the export through its RPC.
5. Write the application's exact bundle bytes to a temporary folder and run the
   v8 Python analysis and its database-written-bundle test without allowing a skip.
   Check independently known denominators and confirmed counts from the planted
   responses. No synthetic performance values are presented as study results.
6. Confirm that the analysis refuses a pilot export, a synthetic export without
   explicit synthetic permission, and ONE_PER_TRIAL without probabilities.

The ONE_PER_TRIAL test probability file contains deliberately fictional values,
not estimated study probabilities. Its presence tests the connection and refusals;
it does not establish Monte Carlo precision, provenance or an approved estimator.

## Reproduce

Set `VERIFY_ANALYSIS_PYTHON` to a Python interpreter containing
`analysis/requirements.txt`, then run:

```sh
node --import tsx --test tests/mu8-roundtrip.test.ts
```

Without that variable, the database scenarios still run, but the separately named
Python availability check reports BLOCKED; that is not a passed analysis integration.
The analysis CI job supplies the interpreter and executes both database-to-Python
scenarios. The PostgreSQL CI job separately runs the full ONE_PER_TRIAL database
lifecycle on a disposable PostgreSQL 16 database. Live Supabase is a different test.

## Remaining deployment gates

- Independent review and CI at the published head.
- Approved definitions, complete version-bound rubric and display wording.
- Database enforcement of the approved allocation, private sample validation and
  recorded investigator approvals; no selection is authorized by this test.
- Further export-validator hardening for externally supplied bundles, including
  complete snapshot/revision/reference consistency and probability provenance.
  The current analysis continues to refuse real-design bundles.
- Authorized live Supabase token/RLS checks and a reviewed deployment plan.

No remote migration, import, gate approval, freeze, account operation or deployment
was performed by this increment.

## Executed checks (2026-10-24)

- `VERIFY_ANALYSIS_PYTHON=<analysis-venv-python> npm run check`: 254 passed,
  zero failed, 33 skipped and one existing todo; typecheck, lint, fixture and
  v4/v5/v7 leakage scans passed with zero violations.
  The subsequently added persisted-v7 upgrade test passed in the targeted run.
- `VERIFY_ANALYSIS_PYTHON=<analysis-venv-python> node --import tsx --test
tests/mu8-roundtrip.test.ts`: five passed, zero failed, one local native
  PostgreSQL skip. Both application-written bundles ran through the supplied
  Python database integration check without a skip.
- `MU7_ALLOW_NO_DB_BUNDLE=1 MU8_ALLOW_NO_DB_BUNDLE=1 <analysis-venv-python>
-m pytest -q analysis`: 449 passed, three standalone bundle skips. The v8
  integration checks are run separately by the preceding command with bundles.
- `npm run test:handoff`: expected outcomes passed; final v7 chain through 0034
  is 360/362 with only the two existing documented exceptions. No new exception.
- `npm run build`: passed, 36 SQL inputs, no local runtime files in the trace.
- `npm run test:e2e:production`: nine passed on the local synthetic server.
- Changed-file formatting and `git diff --check`: passed. Full
  `npm run format:check` still flags the same 14 unchanged files documented in
  the foundation increment.
- Native PostgreSQL locally: BLOCKED. Hosted CI includes the new lifecycle test.
  Live Supabase: NOT TESTED, no remote operations authorized or executed here.
- Migration SHA-256:
  `bc95302cb4c6d7df2c25f23dbb630fb5b64a6d25b7c576d5e276e05a6b96d3e6`.
