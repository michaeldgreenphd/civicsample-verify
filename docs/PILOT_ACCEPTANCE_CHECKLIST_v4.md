# Pilot acceptance checklist, review app version 4

Built 2026-10-20. Completed by the investigator, with Claude Code's evidence, before any formal reviewer is invited. Each item is PASS, FAIL or UNTESTED; UNTESTED is never counted as PASS. Record the evidence (test output file, screenshot, log line) beside each item. The pilot uses only the 10 synthetic SYN- cases and the investigator's two pilot test accounts.

Where the gates are tested: the production database stays LOCKED (no activation, FORMAL import, freeze, assignment or adjudication) until the sign-off. Gates that need a formal phase (sections D to I and L) are tested in a separate staging project with the full synthetic run of `CLAUDE_CODE_MASTER_PROMPT_v4.md` section 9 item 7 (HO4-TESTFX- cases only); the evidence must name the staging project.

**Overall: NOT READY FOR FORMAL AUTHORIZATION.** Engineering evidence only; no investigator signature or approval is supplied. Supabase staging has not been created. The investigator chose local testing first, then staging setup. This checklist preserves the supplied gates and distinguishes local supporting evidence from live acceptance.

## A. Live platform tests (REQUIRED; PGlite results do not count here)

| #   | Gate                                                                                                                                                                                | PASS / FAIL / UNTESTED | Evidence                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------- |
| A1  | `schema.sql`, `migrations/0002_v3_review_design.sql`, `migrations/0003_v4_record_categories_module_b.sql` and every later migration apply without error to a fresh Supabase project | UNTESTED               | Supabase project absent; all migrations apply in the local synthetic suite only.                     |
| A2  | The same migrations apply to PostgreSQL 16                                                                                                                                          | UNTESTED               | Native PostgreSQL CI execution pending for this branch.                                              |
| A3  | The v2 suite, the v3 suite (on 0002 alone and on 0002 + 0003) and the v4 suite pass against PostgreSQL 16, with the step counts of `SCHEMA_TEST_REPORT_v4.md`                       | UNTESTED               | New native runner implemented; local execution BLOCKED without PostgreSQL 16. Hosted result pending. |
| A4  | Role and held-out integrity tests pass through the Supabase client with real JWTs, including the investigator aal2 check                                                            | UNTESTED               | No Supabase project or real roster JWTs. Local test claims do not satisfy this gate.                 |
| A5  | Every migration after 0003 has its own tests and they pass on both platforms                                                                                                        | UNTESTED               | Local additive-migration regressions PASS; Supabase execution absent.                                |

## B. Accounts and roles

| #   | Gate                                                                                                                               | Result   | Evidence                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| B1  | Investigator actions are refused without a multi-factor (aal2) session                                                             | UNTESTED | Synthetic claims tests PASS. Real MFA enrollment/challenge and aal2 gateway denial remain untested.               |
| B2  | An uninvited account cannot sign in to any data                                                                                    | UNTESTED | Local uninvited/forged-role tests PASS; live Supabase admission untested.                                         |
| B3  | An ADJUDICATOR cannot be a pilot account or hold a reviewer row, and cannot adjudicate a case or unit they were assigned to review | UNTESTED | Historical schema tested synthetically; actual staging identities are not provisioned.                            |
| B4  | No page or endpoint uses the service role key                                                                                      | PASS     | Source/index leakage scan and production build trace inspection PASS; no service-role key in the web application. |

## C. Blinding with two real reviewer accounts (do this as R-1, then as R-2, in two browsers)

| #   | Gate                                                                                                                                                                    | Result   | Evidence                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| C1  | Each reviewer sees only their own queue, drafts, reviews, Step 1 records and calibration records                                                                        | UNTESTED | Local independent browser contexts and API tests PASS; required two real reviewer accounts unavailable.                |
| C2  | No page, download or API response shows Tier 0 or Tier 1 labels, AI output, frozen predictions, record categories, provenance results, strata, probabilities or weights | UNTESTED | Local response allowlists and role-negative tests PASS; live PostgREST/browser deployment untested.                    |
| C3  | No packet shows an area root, the subtree rule, enrollment, sex eligibility, participant counts, results, benchmark or PPR values                                       | UNTESTED | Synthetic packet allowlists PASS; real packets not imported or reviewed.                                               |
| C4  | The trial-context packet is unreachable (page and API) until that reviewer's Step 1 is saved; Step 1 is read-only afterwards                                            | UNTESTED | Local two-step browser/API tests PASS; real reviewer sessions unavailable.                                             |
| C5  | A trial-level answer cannot be submitted before Step 1                                                                                                                  | UNTESTED | Local direct RPC/API/browser refusal PASS; real reviewer sessions unavailable.                                         |
| C6  | The investigator sees completion counts only while the formal phase is open: no judgment through any page, view, export or the audit log                                | UNTESTED | Counts-only guard retained. Expanded investigator-access wording needs phase reconciliation; live acceptance untested. |

## D. Pilot, development, calibration and formal separation

| #   | Gate                                                                                                                                                                 | Result   | Evidence                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| D1  | Pilot cases carry SYN- IDs, PILOT mode, and never appear in a FORMAL view or export                                                                                  | UNTESTED | Local ten SYN cases and export-separation regression PASS; full staging acceptance pending.                        |
| D2  | FORMAL import is refused before the pilot sign-off; after design v4 activation it is refused for any ID that is not HO4- (or HO4R- under an approved amendment)      | UNTESTED | Preserved SQL suites exercise refusal; no real import, unlock or activation performed.                             |
| D3  | FORMAL assignment is refused before the v4 freeze and for any case outside the frozen held-out set                                                                   | UNTESTED | Preserved synthetic SQL guards tested; live staging freeze/assignment not performed.                               |
| D4  | Calibration (CAL4-) cases come only from registered development units, go only to FORMAL reviewers, close at the freeze, and never appear in a FORMAL view or export | UNTESTED | Three shared calibration examples requested but not supplied. Their excluded frame units cannot yet be registered. |
| D5  | Formal reviewers see no formal case before the sign-off and the freeze                                                                                               | UNTESTED | Synthetic freeze/signoff guards PASS; staging accounts unavailable.                                                |

## E. Answering, three states, saving

| #   | Gate                                                                                                                          | Result   | Evidence                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| E1  | INSUFFICIENT_INFORMATION is stored as an answer; not-applicable fields are NULL and export as NOT_APPLICABLE                  | UNTESTED | Contract conflict: NOT_APPLICABLE text versus format-4.0 empty CSV for SQL NULL. Resolution pending.           |
| E2  | Drafts resume; submissions are append-only; a revision supersedes, never overwrites; the first submission stays in the export | UNTESTED | Local drafts/amendments/restart tests PASS; ordinary preclose revision policy differs from requested finality. |
| E3  | The reviewer-specific case order is reproducible from the recorded seed                                                       | UNTESTED | Synthetic SQL order tests PASS; staging reviewer order not exercised.                                          |

## F. Snapshot, adjudication and reference lock

| #   | Gate                                                                                                                                                                                                                                           | Result   | Evidence                                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | The adjudicator reads nothing before the formal phase closes                                                                                                                                                                                   | UNTESTED | Synthetic historical phase guard tested; no real adjudicator session.                                                                                                     |
| F2  | The adjudicator never reads Tier 0, Tier 1, AI output, predictions, case records, design rows or exports                                                                                                                                       | UNTESTED | Local adjudicator leakage tests PASS; live gateway untested.                                                                                                              |
| F3  | FORMAL adjudication is refused until the judgment snapshot exists; the formal phase cannot reopen after it                                                                                                                                     | UNTESTED | Synthetic snapshot/close guards PASS; real staging flow not run.                                                                                                          |
| F4  | Under DISAGREEMENTS_ONLY, a concordant case level cannot be adjudicated before the lock and enters the reference by rule; a discordant level needs a reason code; a single-reviewed level is SINGLE_REVIEW_ADJUDICATED or UNRESOLVED_ESCALATED | UNTESTED | Synthetic historical rules tested; single-review pathway conflicts with current two-submission requirement.                                                               |
| F5  | Adjudicator rows are flagged blinded; any investigator adjudication is flagged exposed and the analysis refuses it in the primary reference                                                                                                    | UNTESTED | 0010 now requires the active ADJUDICATOR identity for new rows; historical records remain unchanged. Local RPC/direct/spoof and valid-path tests PASS; Supabase untested. |
| F6  | The v4 lock is refused while a case level the scope requires lacks an adjudication; the v3 lock is refused for Module A                                                                                                                        | UNTESTED | Preserved synthetic lock refusals PASS; live staging untested.                                                                                                            |
| F7  | The comparison view and the reference and prediction exports are empty before the lock                                                                                                                                                         | UNTESTED | Synthetic SQL prelock export refusal PASS; deployed gateway untested.                                                                                                     |
| F8  | An adjudication after the lock is flagged post-unblinding and never replaces the primary reference                                                                                                                                             | UNTESTED | Synthetic primary-reference immutability regression PASS; deployed flow untested.                                                                                         |

## G. Export bundle (format 4.0)

| #   | Gate                                                                                                                                                               | Result   | Evidence                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| G1  | The three files and the manifest have every column and key in `design_v4/EXPORT_TO_PERFORMANCE_SPEC_v4.md`, in contract order                                      | UNTESTED | Local synthetic TypeScript-to-Python bundle contract tests PASS; real staging bundle not generated.                        |
| G2  | The frozen_predictions file rendered at export has the SHA-256 recorded at the freeze; both verification RPCs return matches = true before writing                 | UNTESTED | Local live-SQL synthetic verification RPCs and hash checks PASS; staging freeze not performed.                             |
| G3  | File SHA-256 values and row counts in the manifest match the files                                                                                                 | UNTESTED | Local synthetic manifest/hash tests PASS; staging exports not generated.                                                   |
| G4  | `performance_analysis_v4.py` reads the synthetic staging bundle (with the synthetic switch) and refuses each tampered bundle of the master prompt section 9 item 6 | UNTESTED | Maintained analysis suite and database-to-Python synthetic integration PASS. Required Supabase staging bundle unavailable. |
| G5  | Each export is registered and appears in the audit log                                                                                                             | UNTESTED | Local synthetic audit/export registration PASS; deployed audit verification pending.                                       |

## H. Audit and immutability

| #   | Gate                                                                                                   | Result   | Evidence                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------ |
| H1  | UPDATE, DELETE and TRUNCATE are refused on every append-only table, including every v4 table           | UNTESTED | Preserved SQL suites plus additive immutability regressions PASS locally; Supabase untested.     |
| H2  | The audit hash chain verifies end to end                                                               | UNTESTED | Synthetic SQL audit-chain tests PASS; no deployed chain.                                         |
| H3  | Audit rows for Step 1 records and Module B responses carry identifiers and a hash only (FINDING-V4-01) | UNTESTED | PGlite historical audit probe: exposed decisions fall from 2 to 0 after 0003. Supabase untested. |

## I. Module B (benchmark compatibility and row eligibility)

| #   | Gate                                                                                                                                                      | Result   | Evidence                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| I1  | Row and trial-eligibility units show definitions and registration fields only, never benchmark numbers, participant counts or the pipeline status         | UNTESTED | Synthetic SQL visibility tests only. Module B UI and real qualifications/permission remain pending. |
| I2  | Module B has its own sample freeze, phase, adjudication, reference lock and export, separate from Module A; no MB4- ID reaches a Module A table or export | UNTESTED | Separate Module B schema/tests exist; no active deployed Module B workflow.                         |
| I3  | Responses are refused outside the Module B phase and when the answer does not fit the unit type or misses a required reason or rationale                  | UNTESTED | Synthetic validation and post-lock refusal tests PASS; live gateway untested.                       |

## J. Repository leakage

| #   | Gate                                                                                           | Result | Evidence                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| J1  | `tools/check_public_repo_leakage_v4.py` passes on the repository and runs in CI and pre-commit | PASS   | Adapted upstream v4 checker plus JS index/source guard wired into npm run check, CI and pre-commit; exact results in test_runs. |
| J2  | `data_private/` is gitignored and empty in the repository                                      | PASS   | Private-source exclusions enforced; no data_private files in the public tracked tree.                                           |

## K. Usability (investigator's pilot judgement)

| #   | Gate                                                                                                                  | Result   | Evidence                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| K1  | Median minutes per descriptor case, per trial case and per Module B unit recorded (replaces the planning assumptions) | UNTESTED | Investigator timing/usability session has not been conducted; no case-time estimates invented.                   |
| K2  | Every packet problem raised in the pilot is resolved or logged                                                        | UNTESTED | Automated browser findings recorded; investigator packet review and supplied calibration examples still awaited. |

## L. Held-out integrity (decision sheet, cross-cutting requirements)

| #   | Gate                                                                                                                                                        | Result   | Evidence                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | No development (DEV4-), calibration (CAL4-) or pilot (SYN-) record can be imported, assigned or exported as a held-out case (database and API)              | UNTESTED | Local synthetic exclusion/role tests PASS; real staging database/API validation absent.                                               |
| L2  | A frame unit in the development registry can never be recorded as a held-out case, and a held-out frame unit cannot later be registered as development      | UNTESTED | Hash-first overlap preflight and SQL refusal tests PASS. Development import blocked by activation prerequisite.                       |
| L3  | Provenance results, selection probabilities and weights are retained from import to export unchanged                                                        | UNTESTED | Preflight preserves original strings and validates numerical serialization; local export regressions PASS. Staging round trip absent. |
| L4  | Frozen predictions are write-once and readable by the investigator only; the case-list and prediction hashes recorded at the freeze verify at export        | UNTESTED | Synthetic freeze/read/hash tests PASS; no real predictions loaded. Open-phase investigator restriction retained.                      |
| L5  | A post-freeze ontology version (-DVF) leaves every prediction row and its hash unchanged, and no FORMAL case version can use it                             | UNTESTED | Preserved synthetic SQL version tests PASS; no scientific version chosen or frozen.                                                   |
| L6  | No FORMAL case, case record, prediction, development unit or calibration record can be added after the freeze, and no frozen held-out case can be withdrawn | UNTESTED | Local freeze/concurrency regressions PASS; live Supabase untested.                                                                    |
| L7  | Independent judgments are exported separately from the adjudicated reference, with initial and effective answers; adjudication never edits them             | UNTESTED | Local independent/adjudicated export separation PASS; formal staging flow not performed.                                              |

## Defect log

| ID      | Item | Description                                                                                      | Severity                         | Fixed in (commit) | Retested                      |
| ------- | ---- | ------------------------------------------------------------------------------------------------ | -------------------------------- | ----------------- | ----------------------------- |
| ROLE-01 | F5   | Historical investigator-adjudication insert path closed by additive 0010; old records preserved. | Blocking until live verification | 0010              | Local PASS; Supabase UNTESTED |

## Evidence scope

See [test run evidence](test_runs/STAGING_READINESS.md) and [open questions](OPEN_QUESTIONS.md). The tested implementation commit is recorded there. Local pilot output is never used for performance statistics; the separate HO4-TESTFX bundle tests analysis. The private roster, source contract and study files are not included.

## Original defect-log template

| ID  | Item | Description | Severity | Fixed in (commit) | Retested |
| --- | ---- | ----------- | -------- | ----------------- | -------- |

## Decision and sign-off

Formal authorization is the investigator's decision, recorded with `rpc_unlock_formal_review` (checklist version and SHA-256 of this completed file). Design v4 activation, the freeze and the reference lock are separate attested actions after it. Signed: ____________________ Date: ____________
