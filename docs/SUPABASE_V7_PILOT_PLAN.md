# Supabase synthetic pilot of review design v7: plan for authorization

Staging project `xmuiduugdrqvhssmeacz` only (Free plan). Synthetic accounts and synthetic units only. Nothing in this plan imports a real record, freezes, opens the formal review, approves a gate, or invites anyone. Each remote step needs the investigator's explicit authorization; this document only prepares them. The reviewed commit, the plan file and its SHA-256 are named in the PR that carries this document; a plan generated from any other commit is not this plan.

## 1. Staging today (read-only inspection, 2026-10-23)

`scripts/supabase-readonly-inspect.mjs` (one read-only REPEATABLE READ transaction, rolled back; aggregates only):

| Item                       | Observed                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Destination                | `xmuiduugdrqvhssmeacz`, session pooler, TLS verified with the project CA                                                                                                                                      |
| Schema marker              | `6.0.4-service-role-admin-grants` (migrations through 0022)                                                                                                                                                   |
| PostgreSQL                 | 17.11; `pgcrypto` and `uuid-ossp` in schema `extensions`                                                                                                                                                      |
| Mapping-confirmation pilot | one campaign, LOCKED, PROPOSED condition set; 12 synthetic pilot and 3 training cases; 24 assignments, 24 responses, 2 adjudications, 3 registered exports; events CLOSED, ADJUDICATION_AUTHORIZED, LOCKED    |
| Earlier designs            | no v5/v6 case or activation, no v4 activation, no v2 case or phase event, no v7 object                                                                                                                        |
| Accounts                   | 7 Auth users, all linked: 2 investigators, 1 adjudicator, 2 staging reviewers, 2 pilot reviewers (PILOT scope); 0 active locks; one verified TOTP factor (an investigator); `require_investigator_mfa = true` |
| service_role               | DML only on `users` and `account_locks`; the schema default gives new tables TRUNCATE, REFERENCES, TRIGGER and MAINTAIN                                                                                       |
| Catalog (public, private)  | 76 tables, 18 views, 227 functions, 265 triggers, 83 policies; 189 public rows                                                                                                                                |

Conflicts with v7: none (MU7-G02 refuses a v7 design only next to a v4, v5 or v6 formal or calibration review).

## 2. Backup and recovery (Free plan)

The Free plan gives no backup that this plan relies on. A manual, off-site logical backup was taken read-only with PostgreSQL's own tools (`scripts/supabase-backup.mjs`, pg_dump 17.11 from the signed and notarized Postgres.app 17 image, run from the mounted image, nothing installed). It is in the private staging folder, `backups/2026-10-23-before-v7-final/`, folder mode 700, files mode 600, outside every repository.

| File                        | Contains                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roles.sql`                 | role names and attributes (`pg_dumpall --roles-only --no-role-passwords`); no passwords                                                                       |
| `app.dump`                  | pg_dump custom format of the application schemas `public` and `private`: tables, data, sequences, functions, triggers, policies, grants and owners            |
| `auth-data.dump`            | pg_dump custom format, data only, of schema `auth`: Auth users, identities, factors and sessions. It holds password hashes and TOTP secrets and stays private |
| `manifest.json`             | tool and server versions, live schema markers and catalog counts (read inside BEGIN READ ONLY), size and SHA-256 of each file                                 |
| `restore-verification.json` | the result of the restore check below                                                                                                                         |

Not included: storage objects (none are used), the Supabase-managed schemas and extensions themselves, project settings (Auth configuration, API keys, URLs), and role passwords.

**Restore verified** (`scripts/verify-backup-restore.mjs`) into a disposable local PostgreSQL 17.11 cluster, deleted afterwards: `roles.sql`, then the Auth stand-in and the two extensions a Supabase project provides, then `pg_restore --clean --if-exists --exit-on-error app.dump`. The restored database matches a fresh read-only snapshot of staging: all 22 schema markers; 76 tables, 18 views, 227 functions, 265 triggers and 83 policies; and all 72 public tables row for row (189 rows, identical canonical SHA-256 per table). In that local cluster 21 role-membership grants "as" Supabase-internal roles were refused; a new Supabase project creates those memberships itself, and none affects the application restore.

**Untested, stated explicitly:** restoring `auth-data.dump` (it needs the Supabase Auth schema, which only a Supabase project has; the file was checked readable, 27 table-data entries), and any restore into a new Supabase project. The recovery for Auth that does not need it: re-provision the seven synthetic accounts with the privileged tool (`accounts`, which relinks `users.auth_uid` by e-mail) and re-enrol the investigator's authenticator.

**Restore procedure** (this project after a failed change, or a new project): (1) for a new project, provision it; (2) restore `app.dump` with `pg_restore --clean --if-exists --exit-on-error` (the extensions `pgcrypto` and `uuid-ossp` in schema `extensions` must exist first; a Supabase project has them); (3) restore Auth by re-provisioning the synthetic accounts, or restore `auth-data.dump` only after testing that step on a disposable Supabase project; (4) run the read-only inspection and compare with `manifest.json`.

**Partial apply.** Each migration file is its own transaction: a failing file changes nothing, but files applied before it stay applied (the runner reports the last marker and resumes from there). The v7 lifecycle and gate guards arrive with 0026 to 0030, so **no v7 action may be taken until the final marker is confirmed**; if the apply stops early, fix forward with a reviewed migration or restore from this backup.

## 3. Exact remote changes requested

**A. Schema**: one `apply-schema` run of the reviewed plan; staging applies these files (earlier files are already applied and skipped):

| File | Marker                               | Effect                                                                               |
| ---- | ------------------------------------ | ------------------------------------------------------------------------------------ |
| 0023 | `6.0.5-service-role-truncate-revoke` | revokes TRUNCATE, REFERENCES, TRIGGER from service_role                              |
| 0024 | `7.0.0`                              | review design v7 (supplied migration, byte-identical)                                |
| 0025 | `7.0.1-v7-review-fixes`              | audit digests, serialization, lock-aware adjudicator                                 |
| 0026 | `7.0.2-v7-lifecycle-and-gates`       | pilot inventory rules; gates recorded as pending; FORMAL freeze and opening disabled |
| 0027 | `6.0.6-service-role-least-privilege` | service_role keeps exactly the 0022 administration grants; schema default follows    |
| 0028 | `7.0.3-v7-gate-specifications-v8-1`  | G-PAIN-01 and G-MH-V53 specified with their decision records; nothing approved       |
| 0029 | `7.0.4-v7-versioned-gate-approvals`  | approvals keyed to requirement versions, append-only                                 |
| 0030 | `7.0.5-v7-current-unit-freeze-gates` | units held by a gate are frozen only with an approval of its current requirement     |

Expected final marker: `7.0.5-v7-current-unit-freeze-gates`. The apply refuses any plan hash but the reviewed one.

**B. Pilot records** (the investigator in the browser; the reviewer and adjudicator phases under their own tokens): one synthetic design (`SYN-7-SYNTHETIC-PILOT`), 12 synthetic pilot units, 3 synthetic worked examples, 24 queue rows, 24 initial answers, 5 tie-breaks, one PILOT reference lock, one PILOT export registration, optional training acknowledgments, and their audit rows. No FORMAL unit, freeze, formal phase event or gate approval.

**C. Account operation**: `lock` then `unlock` of `syn-reviewer-1` with the privileged tool (one `account_locks` row, kept and released; an Auth ban and its removal); the account itself is preserved.

## 4. The coexistence guard is not needed for this pilot

On staging the paths it would close are already closed: an evaluation mapping case is refused by 0018 and the only campaign is LOCKED; a v2 formal unlock needs a v2 pilot (there is none); once the v7 design is recorded, 0024 refuses new v5/v6 formal, calibration and training cases, v4/v5 activation and new v2 formal cases. It stays prepared and unapplied pending the investigator's decision.

## 5. Running the app against staging

The local walkthrough keeps port 3300; Supabase testing uses port 3400 (`--port` sets the accepted origin; the two modes use different cookie names). Use a separate browser profile or private window for staging. Build from the reviewed commit on a clean tree:

```
npm run build
node scripts/supabase-web.mjs check --config "$HOME/Private/civicsample-verify-staging/web-app.json"
node scripts/supabase-web.mjs start --config "$HOME/Private/civicsample-verify-staging/web-app.json" --port 3400
```

**Investigator sign-in with the second factor (browser only):** open `http://127.0.0.1:3400`, sign in as `syn-investigator-1` with the password from the private sign-in file, then enter the current six-digit code from the authenticator app when the page asks for it. Codes and passwords are typed into the page only, never into chat.

The live tests read `VERIFY_SUPABASE_WEB_CONFIG` (that file) and `VERIFY_SUPABASE_SIGNIN` (the private sign-in file, which must be owner-only and outside every repository); without them every check reports BLOCKED.

## 6. Runbook and expected results

| Step | Who                           | Action                                                                                                                      | Expected                                                                                                                                                                                                          |
| ---- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | operator                      | read-only inspection; fresh backup and its restore check                                                                    | section 1 unchanged; restore check passes                                                                                                                                                                         |
| 2    | operator, authorized          | `apply-schema` with the reviewed plan hash                                                                                  | eight files applied; final marker `7.0.5-v7-current-unit-freeze-gates`                                                                                                                                            |
| 3    | operator                      | read-only inspection                                                                                                        | v7 objects present and empty; 2 gates SPECIFIED, 8 pending, 0 approvals; mapping-confirmation pilot unchanged (counts and events as in section 1); service_role per 0027. Stop here if the marker differs         |
| 4    | test                          | `VERIFY_STAGING_V7_PHASE=restrictions`                                                                                      | reviewers, the adjudicator and the second investigator (no second factor) are refused every investigator action and approval; the phase stops before any write unless the investigator-only read is refused first |
| 5    | investigator, browser         | record the synthetic design; import the pilot units and worked examples; assign both pilot queues                           | 12 units, 3 worked examples, 24 assignments                                                                                                                                                                       |
| 6    | test                          | `VERIFY_STAGING_V7_PHASE=reviewers`                                                                                         | planted answers recorded; the DISAGREE without a note refused (MU7-G36); isolation; a new session reads every answer back. Resumable: a rerun validates what is on record and adds no revision                    |
| 7    | reviewers, browser (optional) | open a unit, reload                                                                                                         | the answer is on record and the form starts from it                                                                                                                                                               |
| 8    | test                          | `VERIFY_STAGING_V7_PHASE=adjudicator`                                                                                       | exactly the 5 routed units; routing as the walkthrough expects; missing tie-breaks recorded, existing ones validated and skipped; a second tie-break refused (separate test)                                      |
| 9    | investigator, browser         | lock the pilot reference; build the export; download the manifest and four files into a private folder; register the export | lock of 12 units; registration recorded                                                                                                                                                                           |
| 10   | test                          | `VERIFY_STAGING_V7_PHASE=after-lock`                                                                                        | no answer accepted (MU7-G34); every tie-break recorded; the reference shows as locked                                                                                                                             |
| 11   | operator                      | `node --import tsx scripts/verify-mu7-bundle.ts --bundle <private folder> --expect-manifest-sha256 <registered hash>`       | every hash, column list and row count as the contract and the registration                                                                                                                                        |
| 12   | operator, authorized          | `VERIFY_STAGING_V7_PHASE=account-lock` with the admin configuration                                                         | a token issued before the lock resolves to no user while locked; sign-in refused; the same token works after the release; the release runs even if the lock stops part-way                                        |
| 13   | operator                      | read-only inspection                                                                                                        | v7 pilot counts as in section 3B; mapping-confirmation pilot unchanged; 0 gate approvals unless the investigator chose to approve                                                                                 |

## 7. Not part of this pilot

The FORMAL import, freeze and opening; real records; reviewer invitations; a shared website (a separate plan after this pilot passes); the paid AI workflow.
