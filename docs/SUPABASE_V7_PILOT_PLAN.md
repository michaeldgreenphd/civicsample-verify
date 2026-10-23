# Supabase synthetic pilot of review design v7: plan for authorization

Staging project `xmuiduugdrqvhssmeacz` only. Synthetic accounts and synthetic units only. Nothing in this plan imports a real record, freezes, opens the formal review, approves a gate, or invites anyone. Each remote step below needs the investigator's explicit authorization; this document only prepares them.

## 1. What staging holds today (read-only inspection, 2026-10-23)

`scripts/supabase-readonly-inspect.mjs` (one read-only transaction, rolled back; aggregates only):

| Item                       | Observed                                                                                                                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema marker              | `6.0.4-service-role-admin-grants` (migrations through 0022)                                                                                                                                                           |
| PostgreSQL                 | 17.x; `pgcrypto` in schema `extensions` (needed by 0024 and 0025)                                                                                                                                                     |
| Mapping-confirmation pilot | one campaign, LOCKED; 12 synthetic pilot and 3 training cases; 24 assignments, 24 responses, 2 adjudications, 3 registered exports                                                                                    |
| Earlier designs            | no v5/v6 cases or activation, no v4 activation, no v2 case or phase event, no v7 object                                                                                                                               |
| Accounts                   | 7 Auth users, all linked: 2 investigators, 1 adjudicator, 2 staging reviewers, 2 pilot reviewers (enrolled with PILOT scope); 0 active locks                                                                          |
| Second factor              | one verified TOTP factor, on an investigator; none elsewhere; `require_investigator_mfa = true`                                                                                                                       |
| service_role               | DML only on `users` and `account_locks`, SELECT on three verification tables; TRUNCATE, REFERENCES and TRIGGER on every table; the schema default for new tables grants it TRUNCATE, REFERENCES, TRIGGER and MAINTAIN |

A read-only record-level snapshot was also taken (`scripts/supabase-readonly-snapshot.mjs`: 72 public tables, 189 rows) into the private staging folder as a baseline.

Conflicts with v7: none. Recording a v7 design is refused only when a v4, v5 or v6 formal or calibration review exists (MU7-G02); staging has none. The existing synthetic mapping-confirmation pilot is untouched by every migration in the plan.

## 2. Exact remote changes requested

**A. Schema** (one `apply-schema` run of the reviewed plan; each file is its own transaction; the runner resumes after the last applied file):

| File | Marker                               | Effect                                                                                                                      |
| ---- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 0023 | `6.0.5-service-role-truncate-revoke` | revokes TRUNCATE, REFERENCES, TRIGGER from service_role                                                                     |
| 0024 | `7.0.0`                              | review design v7 (supplied migration, byte-identical)                                                                       |
| 0025 | `7.0.1-v7-review-fixes`              | audit digests, serialization, lock-aware adjudicator                                                                        |
| 0026 | `7.0.2-v7-lifecycle-and-gates`       | pilot inventory rules, gates recorded as pending, FORMAL freeze and opening disabled                                        |
| 0027 | `6.0.6-service-role-least-privilege` | service_role keeps exactly the 0022 administration grants; schema default follows                                           |
| 0028 | `7.0.3-v7-gate-specifications-v8-1`  | G-PAIN-01 and G-MH-V53 specified with their decision records; nothing approved                                              |
| 0029 | `7.0.4-v7-versioned-gate-approvals`  | gate approvals keyed to requirement versions, append-only; a re-specified gate can be approved again, citing its new record |

The plan file, its SHA-256 and the destination are produced by `node scripts/supabase-admin.mjs plan --config <private admin config>` at the reviewed commit; the apply refuses any other plan hash.

**B. Data written during the pilot** (by the investigator in the browser, and by the scripted reviewer and adjudicator sessions under their own tokens): one synthetic design record (`SYN-7-SYNTHETIC-PILOT`), 12 synthetic pilot units, 3 synthetic worked examples, 24 queue rows, 24 initial answers (plus any revisions), 5 tie-breaks, one PILOT reference lock, one PILOT export registration, optional training acknowledgments, and their audit rows. No FORMAL unit, freeze, phase event or gate approval is part of the pilot.

**C. Account operation** (only in the account-lock phase): `lock` then `unlock` of the staging reviewer `syn-reviewer-1` with the privileged tool: one `account_locks` row (kept, released), an Auth ban and its removal.

## 3. Is the proposed coexistence guard needed for this pilot?

No. On staging the paths the guard would close are already closed:

- An evaluation mapping-confirmation case is refused by 0018, and the only campaign is LOCKED (a second campaign cannot be created).
- A v2 formal unlock needs a completed v2 pilot; staging has no v2 case.
- Once the v7 design is recorded, 0024 itself refuses new v5/v6 formal, calibration and training cases, v4/v5 activation and new v2 formal cases (MU7-G04 to G06).

The guard matters only if a later change re-enables evaluation import or a v2 formal review on a database that runs v7. It stays prepared and unapplied (`migrations/proposed/v7_cross_design_coexistence.sql`) pending the investigator's decision.

## 4. Backup and recovery before the schema change

1. **Provider backup.** In the Supabase dashboard (Database, Backups), confirm that a recent backup of `xmuiduugdrqvhssmeacz` exists, and note whether point-in-time recovery is available on the plan. This is the investigator's check; no API key for it is held here.
2. **Record-level snapshot.** Immediately before the apply, run the read-only snapshot again into a new private file and keep its printed SHA-256 with the apply log.
3. **Inspection before and after.** Run the read-only inspection before the apply and after it; the after-run must show the seven new markers, the unchanged mapping-confirmation counts and the service_role grants of 0027.
4. **Recovery.** Every migration is additive and runs in its own transaction, so a failing file changes nothing and the runner stops; fix forward with a new numbered migration. Restoring the provider backup is the fallback for anything else; the snapshot shows which records changed.

## 5. Connection test: the app locally against staging

Stop the local walkthrough server first (it uses port 3300, the staging web configuration's site origin); its database and credentials stay as they are. Build from the reviewed commit on a clean tree, then:

```
npm run build
node scripts/supabase-web.mjs check --config "$HOME/Private/civicsample-verify-staging/web-app.json"
node scripts/supabase-web.mjs start --config "$HOME/Private/civicsample-verify-staging/web-app.json" --port 3300
```

The tests below use `VERIFY_SUPABASE_WEB_CONFIG` (that file) and `VERIFY_SUPABASE_SIGNIN` (the private synthetic sign-in file); without them every check reports BLOCKED.

## 6. Runbook and expected results

| Step | Who                           | Action                                                                                                                            | Expected                                                                                                                                                                                    |
| ---- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | operator                      | read-only inspection and snapshot                                                                                                 | as in section 1                                                                                                                                                                             |
| 2    | operator, authorized          | `apply-schema` with the reviewed plan hash                                                                                        | seven files applied; final marker `7.0.4-v7-versioned-gate-approvals`                                                                                                                       |
| 3    | operator                      | read-only inspection                                                                                                              | v7 objects present and empty; 2 gates SPECIFIED, 8 pending, 0 approvals; mapping-confirmation counts unchanged; service_role per 0027                                                       |
| 4    | test                          | `VERIFY_STAGING_V7_PHASE=restrictions`                                                                                            | reviewers, the adjudicator and the second investigator (no second factor) are refused every investigator action and gate approval; none reads the export views or design rows               |
| 5    | investigator, browser         | sign in with the authenticator; record the synthetic design; import the pilot units and worked examples; assign both pilot queues | 12 units, 3 worked examples, 24 assignments                                                                                                                                                 |
| 6    | test                          | `VERIFY_STAGING_V7_PHASE=reviewers`                                                                                               | both pilot reviewers answer the planted answers; the DISAGREE without a note is refused (MU7-G36); neither reaches the other's assignment or answers; a new session reads every answer back |
| 7    | reviewers, browser (optional) | open a unit, reload the page                                                                                                      | the answer is on record and the form starts from it                                                                                                                                         |
| 8    | test                          | `VERIFY_STAGING_V7_PHASE=adjudicator`                                                                                             | the adjudicator sees exactly the 5 routed units; every unit's routing equals the walkthrough's expectation; a concordant unit is not found; a second tie-break is refused                   |
| 9    | investigator, browser         | lock the pilot reference; build the export; download manifest and the four files into a private folder; register the export       | lock of 12 units; registration recorded                                                                                                                                                     |
| 10   | test                          | `VERIFY_STAGING_V7_PHASE=after-lock`                                                                                              | no answer accepted after the lock (MU7-G34); every tie-break recorded; the reference shows as locked                                                                                        |
| 11   | operator                      | `node --import tsx scripts/verify-mu7-bundle.ts --bundle <private folder> --expect-manifest-sha256 <registered hash>`             | every file hash equals the manifest; the manifest equals the registration; columns and row counts as the contract                                                                           |
| 12   | operator, authorized          | `VERIFY_STAGING_V7_PHASE=account-lock` with the admin configuration and the apply authorization                                   | a token issued before the lock resolves to no user while locked; sign-in is refused; the same token works again after the release                                                           |
| 13   | operator                      | read-only inspection                                                                                                              | v7 pilot counts as in section 2B; mapping-confirmation counts unchanged; 0 gate approvals unless the investigator chose to approve                                                          |

The investigator may approve G-PAIN-01 or G-MH-V53 in the console at any time; that is the investigator's own act, cites the decision record the requirement names, and leaves the FORMAL freeze and opening disabled while the other gates are pending.

## 7. Still not part of this pilot

The FORMAL import, freeze and opening; real records; reviewer invitations; a shared website (a separate plan after this pilot passes); the paid AI workflow.
