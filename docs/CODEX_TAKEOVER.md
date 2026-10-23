# Codex takeover: state on 2026-10-23

Handoff from Claude Code to Codex, who becomes the only editor of this branch. Public file: synthetic facts only. Local paths, private file locations, account names beyond the synthetic usernames, and the backup location are in an owner-only handoff outside every repository; the investigator has its path. Nothing here approves a gate, a rubric, a sample or a deployment.

## 1. Repository, branch and pull requests

- Repository `michaeldgreenphd/civicsample-verify` (public). Worktree path: owner-only handoff.
- Branch `codex/v7-supabase-pilot`. HEAD is the commit that adds this file; its parent `f9328dc` holds the last code and documentation change. The full HEAD SHA is in the final handoff message and the owner-only handoff.
- Draft pull requests, stacked, merge commits only, none merged:

| PR  | Branch                    | Head        | Base                         |
| --- | ------------------------- | ----------- | ---------------------------- |
| #7  | `codex/supabase-identity` | `6661144`   | `codex/mapping-confirmation` |
| #8  | `codex/v7-mapping-units`  | `37a08c0`   | `codex/supabase-identity`    |
| #9  | `codex/v7-review-fixes`   | `2a45092`   | `codex/v7-mapping-units`     |
| #10 | `codex/v7-app-workflow`   | `3a51c70`   | `codex/v7-review-fixes`      |
| #11 | `codex/v7-supabase-pilot` | this commit | `codex/v7-app-workflow`      |

Do not merge the commits made for v8.1 item 1 (section 6) until the investigator decides.

## 2. Work in this phase

Committed on #11 after the reviewed commit `42bd1b7`:

- `f9328dc`: the run record (docs/SUPABASE_V7_PILOT_PLAN.md section 8); the live refusal check now targets a gate pending specification; docs/SHARED_PRACTICE_DEPLOYMENT.md.
- This commit: this file.

Uncommitted: nothing. A detached, clean checkout of `42bd1b7` outside the repository serves the staging application (section 5); it is not a branch and holds no change.

## 3. Commands executed and results

`$PRIVATE` stands for the owner-only staging folder (owner-only handoff).

| Command                                                                                                                                                            | Result                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Hosted CI on `42bd1b7` (push and pull-request runs)                                                                                                                | PASS: `analysis`, `postgres`, `web`                                                                                                  |
| `node scripts/supabase-admin.mjs plan --config $PRIVATE/supabase-admin.json`                                                                                       | plan SHA-256 `34b9bf3f…15c2`, identical to the reviewed plan; destination `xmuiduugdrqvhssmeacz`, session pooler                     |
| `node scripts/supabase-readonly-inspect.mjs --config …` (before)                                                                                                   | unchanged from the earlier inspection; TLS verified; marker `6.0.4-service-role-admin-grants`                                        |
| `node scripts/supabase-backup.mjs --config … --pg-bin <PostgreSQL 17.11 bin> --out-dir $PRIVATE/backups/<new folder>`                                              | BACKUP_WRITTEN_READ_ONLY (summary read inside BEGIN READ ONLY)                                                                       |
| `node scripts/verify-backup-restore.mjs --backup … --pg-bin … --config …`                                                                                          | ok: app restore OK, catalog identical, 72/72 tables identical (189 rows), auth dump readable, Auth restore UNTESTED                  |
| `VERIFY_SUPABASE_ADMIN_APPLY=1 node scripts/supabase-admin.mjs apply-schema --config … --apply --confirm-project xmuiduugdrqvhssmeacz --plan-sha256 34b9bf3f…15c2` | APPLIED: 0023 to 0030; earlier files skipped                                                                                         |
| read-only inspection (after)                                                                                                                                       | final marker `7.0.5-v7-current-unit-freeze-gates`; see section 4                                                                     |
| `npm run build` (clean checkout of `42bd1b7`)                                                                                                                      | PASS; trace check: 6 manifests, 32 SQL inputs, no local runtime files                                                                |
| `node scripts/supabase-web.mjs check --config $PRIVATE/web-app.json`                                                                                               | OK; sign-ups disabled                                                                                                                |
| `VERIFY_STAGING_V7_PHASE=restrictions node --import tsx --test tests/staging-live-v7.test.ts` (with `VERIFY_SUPABASE_WEB_CONFIG`, `VERIFY_SUPABASE_SIGNIN`)        | PASS (1; 5 not selected)                                                                                                             |
| same, `VERIFY_STAGING_V7_PHASE=account-lock` (with `VERIFY_SUPABASE_ADMIN_CONFIG`, `VERIFY_SUPABASE_ADMIN_APPLY=1`, `VERIFY_STAGING_V7_PLAN_SHA256`)               | PASS (1); account restored to unlocked, fresh sign-in OK                                                                             |
| `npm run check` (working tree of `f9328dc`)                                                                                                                        | 254 tests: 221 pass, 0 fail, 32 skipped (native PostgreSQL suites BLOCKED: no local server); fixture and v4/v5/v7 leakage scans pass |

Not run, BLOCKED on the investigator's browser sign-in with the second factor: pilot steps 5 to 11 and 13 (record the synthetic design, import, assign, the `reviewers`, `adjudicator` and `after-lock` phases, the pilot lock, export, registration, bundle verification, final inspection). Not run in this phase: `npm run test:e2e` and the handoff suites (last results at `42bd1b7`: production e2e 5/5, handoff through 0030 360/362); native PostgreSQL locally (BLOCKED; CI `postgres` job passed).

## 4. Staging after this run (synthetic project only)

- Schema: 30 markers, final `7.0.5-v7-current-unit-freeze-gates`; migrations 0023 to 0030 applied today.
- v7: design 0, units 0, training units 0, assignments 0, judgments 0, adjudications 0, freezes 0, phase events 0, reference locks 0, exports 0.
- Gates: G-PAIN-01 v2 and G-MH-V53 v2 SPECIFIED; G-PROV-01, G-PROV-02, G-PROV-03, G-OVERLAP-01, G-TEXT-01, G-OQ-03, G-OQ-04, G-EST-01 PENDING_SPECIFICATION (v1); approvals 0.
- Mapping-confirmation pilot unchanged: one LOCKED campaign, 12 synthetic pilot and 3 training cases, 24 assignments, 24 responses, 2 adjudications, 3 registered exports.
- Accounts: 7 Auth users, all linked and active (2 investigators, 1 adjudicator, 2 staging reviewers, 2 pilot reviewers), 0 active locks; one verified TOTP factor (an investigator); `account_locks` holds one more released row (the lock test).
- service_role: exactly the 0022 administration grants; the schema default no longer gives it new-table privileges.

## 5. Running locally

- Port 3300: the local v7 walkthrough (PGlite, the investigator's completed walkthrough database). Leave it running and untouched.
- Port 3400: the production build of `42bd1b7` in Supabase mode against staging, served from a clean detached checkout. Restart: from that checkout, `node scripts/supabase-web.mjs start --config $PRIVATE/web-app.json --port 3400`.
- Paths of both databases and checkouts: owner-only handoff.

## 6. Coordination note v8.2: reconciliation

1. **Pain (v8.1 item 1 withdrawn pending the investigator).** Derived from it: `85c8e27` (REVIEW_RUBRIC_v7.md line "Pain (descriptive row)", the supplied copy kept verbatim, RUBRIC_PROVENANCE_v7.md, tests/rubric-provenance-v7.test.ts); `35bec7f` (migration 0028: G-PAIN-01 v2 SPECIFIED citing the manuscript decision; tests/mu7-gates-v8-1.test.ts; lifecycle and fixture expectations); `e4d19e4` (approval controls, which name the specified decision record; the local app test approves G-PAIN-01 in a disposable database only). Later commits build on them: `4f8c180` (0029, a Pain re-specification test), `7bf8e3e` (0030). No gate approval exists on staging or in any migration, fixture or script; approvals occur only inside disposable test databases. 0028 is now applied on staging; it specifies, it does not approve, and the synthetic pilot does not depend on it. Not undone: the rubric line, 0028 and the tests stay as committed, unmerged. If the investigator decides that the manuscript decision does not settle the application gate, append G-PAIN-01 v3 (PENDING_SPECIFICATION or a new requirement) in a reviewed migration and restore the rubric wording in a new revision; approvals are per requirement version, so nothing carries over.
2. **Review scope.**
   - Matches: two reviewer slots on every unit (queue rows and opening both require 2 per unit); worked examples in a separate table with read-only packets and no answer table; PILOT units marked SYNTHETIC_PILOT, carrying the exclusion notice, filtered out of exports and refused by the analysis; subgroup units only after all primary units, restating the parent row; the adjudicator sees routed units only, with the label; no AI field, label or second review component in the v7 tables, packets, DTOs or export (key allow-lists; the export refuses prediction/model columns).
   - Gaps (recorded, not changed): the 100 units and the 56/40/4 split are not fixed in the database; the freeze checks counts against the investigator's design row, so the design record must say 100. "Exactly three" worked examples is not enforced (seeded data only). The analysis names the outcome "clinician confirmation of displayed assignments", not PPV or accuracy; the application and the export manifest do not name the outcome at all. Allow-lists check key names, not free text.
3. **Formal gates.** Freeze blocked by G-MH-V53, G-PROV-01, G-OVERLAP-01, G-TEXT-01 (MU7X-G06); opening blocked by those and G-PAIN-01, G-OQ-03, G-OQ-04, G-EST-01 (MU7X-G07); the Pain units' own freeze hold is MU7-G29 with MU7X-G10. G-PROV-02 and G-PROV-03 block nothing: PV09 and PV03 (the six former calibration trials) are frame and draw rules applied before import, and the database does not check them. The Pain unit hold depends on the import file setting `freeze_gate` on the Pain units; no constraint ties category to gate. The application has no freeze or opening action at all. A passed supporting check (G-MH-V53) is not an approval. Documentation that still says Pain is "provisional" or "open", and the supplied PENDING_DECISIONS table whose "blocks" column describes scientific steps rather than database operations, are left as they are.
4. **Reviewer independence.** The rule-book packet is not in the repository or the application, and its examples were not added to reviewer materials. The signer/adjudicator arrangement and the reported rule-level overlap are unresolved scientific matters; no arrangement was chosen.
5. **AI experiment.** Separate from this application. No spending is authorized by either draft: the unsigned draft addendum 10 (items 52 to 59, AI-D1 to AI-D8) supersedes the addendum 9 spending references, which this repository never contained. No AI implementation or paid call was started.

## 7. Review status

- #11: the independent re-review of `42bd1b7` found no further blocking finding (it ran the gate, live-phase, pilot-tool, account-lock and service-role tests: 20/20); its earlier three findings are fixed and answered. The automated Codex review of `3d414f9` failed on the usage limit; no new automatic review was requested.
- #7: Codex findings answered (fixed in #11). #8 and #10: their Codex reviews have shown "running" since the morning (stale). #9: Codex clean at `2a45092`.

## 8. Next actions for Codex

1. Read sections 6 and 7 and the owner-only handoff. Do not approve a gate, change the rubric or merge.
2. With the investigator (browser, second factor, never in chat): pilot step 5 at port 3400 (record the synthetic design, import the pilot units and worked examples, assign both pilot queues). Remind the investigator that the gate panel offers approvals and that none is authorized.
3. Run the `reviewers` phase, then `adjudicator` (resumable, section 6 of the pilot plan), the investigator's lock, export build, download and registration, then `after-lock`, `scripts/verify-mu7-bundle.ts` against the registered manifest hash, and a final read-only inspection. Stop on any difference from the expected counts.
4. Implement the deployment changes of docs/SHARED_PRACTICE_DEPLOYMENT.md section 3 in additive commits with tests; get the investigator's approval of the concrete host before creating any account or deployment, then run section 5 on the deployed URL.
5. Before 2026-10-30, add a test that every table the application reads through PostgREST has an explicit grant, and keep grants explicit in every new migration.
6. Keep the Free-plan limits in view: the project pauses after 7 days without database activity; Auth restore is untested.
7. Report exact results; PostgreSQL or Supabase checks that cannot run are BLOCKED.
