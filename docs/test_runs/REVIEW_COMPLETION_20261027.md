# Review completion verification — 2026-10-27

Scope: migration 0040; explicit guide-5 protocol; self-finish receipts; all Cannot tell routing;
bundle 8.4 and sample counts. No operational database, deployed app or real review was changed.

Application build: `06ac929`; final browser regressions: `2db6536`. The latter changes test
selectors only. The production build and browser suite ran in a separate disposable checkout,
preserving the existing local walkthrough, practice answers and prepared real-data project.

## Executed locally

The analysis commands used the existing Python environment with `analysis/requirements.txt`
installed. No private packets or operational databases were used in any test.

| Command / check                                                                                                                                                                                                                   | Observed outcome                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VERIFY_ANALYSIS_PYTHON="$TEST_PYTHON" npm run check`                                                                                                                                                                             | PASS: typecheck, lint, 414 tests passed, 0 failed, 42 skipped, 1 existing TODO. Fixture scan and v4/v5/v7 leakage scans passed with zero violations.                                   |
| `MU7_ALLOW_NO_DB_BUNDLE=1 MU8_ALLOW_NO_DB_BUNDLE=1 "$TEST_PYTHON" -m pytest -q analysis`                                                                                                                                          | PASS: 592 passed, 39 skipped. Historical analytical compatibility only; no new estimator is approved or validated.                                                                     |
| `node --import tsx --test --test-name-pattern='completion protocol\|finish locks\|two final Cannot\|application service' tests/mu84-completion.test.ts tests/mu84-app.test.ts tests/mu8-roundtrip.test.ts tests/mu7-rest.test.ts` | PASS: 6 passed, 0 failed, 1 native test skipped.                                                                                                                                       |
| `npm run test:handoff`                                                                                                                                                                                                            | PASS with the existing documented lineage exceptions. Current full-chain v7 suite: 360/362; schema-version inventory and stricter adjudicator check differ from the supplied baseline. |
| `npm run build`                                                                                                                                                                                                                   | PASS: 7 manifests, 42 SQL inputs; no private/local runtime files in the traced bundle.                                                                                                 |
| `npm run test:e2e:production`                                                                                                                                                                                                     | PASS: 27/27 served-browser scenarios. Includes synthetic database workflow and intercepted DTO timing/error scenarios.                                                                 |
| `npm run typecheck`, `npm run lint` after UI changes                                                                                                                                                                              | PASS.                                                                                                                                                                                  |
| Prettier check of every changed supported file                                                                                                                                                                                    | PASS.                                                                                                                                                                                  |
| `npm run format:check`                                                                                                                                                                                                            | FAIL: 13 supplied fixture/harness/design files already fail on the parent. All 13 are byte-unchanged by this increment; immutable supplied materials were not reformatted.             |
| `git diff --check`                                                                                                                                                                                                                | PASS.                                                                                                                                                                                  |

## What the checks establish

- The protocol is an explicit, immutable, hash-bound opt-in. Binding it records no scientific
  approval. Reviewer, adjudicator, outsider and investigator-without-MFA attempts are refused.
- A reviewer cannot finish an incomplete or stale answer set. Finishing is idempotent, locks
  subsequent revisions in the database, and does not expose the other reviewer's receipt or
  progress. Audit events contain keyed digests instead of enumerable answer hashes.
- In the complete synthetic formal lifecycle, 100 mappings have 200 final independent judgments
  and 202 immutable history rows. Both completion receipts are required before complete close.
  A both-Cannot-tell mapping routes to adjudication and retains its independent-answer flag
  after resolution. Lock, export 8.4, offline verification and sample-count reporting pass.
- The verifier rejects altered receipts, flags, current guide and downgraded formats even when
  a test rewrites the corresponding unregistered manifest. The registered manifest checksum
  remains the authenticity boundary. Legacy modes and guide-4 exports retain their behavior.
- Local and PostgREST-shaped service tests exercise the new path. These are not live Supabase
  evidence. The browser route test also refuses finish requests from non-reviewer sessions.
- At 1280px, 390px and 320px, the finish controls fit without horizontal page overflow, have
  48px targets and separate confirmation/action spacing. Synthetic screenshots were inspected.
  Browser tests preserve unsaved changes, reject stale confirmations, and keep the form locked
  after a confirmed finish even when the subsequent progress refresh fails. Axe checks pass
  for the tested guide and existing review screens; this is not a complete accessibility audit.

The first browser runs exposed test synchronization and selector mistakes (the next case had
not loaded, a saved answer uses "Save revision", and Next also supplies an alert announcer).
The final 27-scenario run above waits for the named case and targets the correct controls.
An earlier full-check upgrade failure was fixed by checking the schema marker before reading
the new protocol table; permission/query failures are still surfaced rather than swallowed.

## Required follow-up environments

- **Native PostgreSQL: BLOCKED locally** (no server or Docker). CI explicitly includes both
  finish-first and revision-first concurrent transactions plus the 100-mapping lifecycle.
  A skipped local check is not a pass; inspect the hosted job for the reviewed head.
- **Live Supabase JWT/RLS: NOT TESTED for migration 0040.** No migration, protocol binding,
  account change, real import, gate approval, freeze, opening or invitation was performed.
- **Hosted-browser rehearsal: NOT TESTED for this increment.** Requires the reviewed migration,
  explicit protocol binding and a separately authorized synthetic environment.
- **Population estimator and interval coverage: NOT TESTED / awaiting scientific decision.**
  The new report deliberately produces counts only and preserves the fields needed later.

## PR #43 inventory finding

Reproduced the review finding before the fix: a direct bundle-8.4 registration with the
`units` inventory removed was accepted. Additive migration 0041 extends the existing pilot
inventory trigger to 8.4; no existing migration, lock, export or judgment is edited.

- `VERIFY_ANALYSIS_PYTHON="$TEST_PYTHON" npm run check`: PASS, 414 passed, 0 failed,
  43 skipped and the existing coexistence TODO. Typecheck, lint and all leakage scans pass.
  The first run exposed a fixed-length version-list expectation; the rerun checks from the
  original v5 marker and includes the new migration.
- Direct-RPC regression: missing, zero, smaller, larger and noncanonical unit counts are
  refused; none is registered, and the genuine 12-unit bundle registers successfully.
- `npm run test:handoff`: PASS with the same documented differences; full chain through 0041
  is 360/362 (schema inventory and intentionally stricter adjudicator access).
- Added a native PostgreSQL pilot-export regression to CI. Locally it is **BLOCKED**, not a pass.
- `git diff --check`: PASS. No remote database operation was part of this fix.
