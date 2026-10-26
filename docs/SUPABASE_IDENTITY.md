# Supabase identity and staging bootstrap (prepared, not applied)

The tooling accepts only the explicitly listed projects below, each through its own private configuration. The completed pilot and practice projects have separate historical verification records. Adding a project to the allowlist prepares a connection; it does not apply a schema, provision accounts, import cases or authorize clinical review. No credentials belong in this repository.

## Requirements (investigator, 2026-10-22)

Individually assigned usernames and passwords; no personal e-mail address from any reviewer; investigator-managed resets; verified user sessions with permissions enforced by database RLS/RPCs and server checks; no service-role key in the web application; no custom password storage, shared account, fabricated JWT claim or MFA bypass; privileged provisioning and reset tooling separate from the web app.

## Design, checked against the Supabase documentation

| Requirement                  | Design                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Documentation basis                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Username, no personal e-mail | Supabase Auth has no username provider; each username maps to an internal, never-deliverable address `<username>@<project-ref>.accounts.invalid` (RFC 2606 reserved domain). The account is created by the privileged tool with `email_confirm: true`, so no message is ever sent.                                                                                                                                                                                                                                                                                                                                             | `auth.admin.createUser({ email, password, email_confirm: true })` is server-only ("Never expose your service_role key in the browser"); admin changes "are applied directly without confirmation flows".      |
| Passwords                    | Supabase stores and checks passwords; the tool only generates a random 32-character password once and writes it to a private file for out-of-band handover. Minimum length and leaked-password protection are dashboard settings.                                                                                                                                                                                                                                                                                                                                                                                              | Auth password policy settings; no application code stores or hashes passwords.                                                                                                                                |
| Investigator-managed resets  | `reset-password` calls `auth.admin.updateUserById(id, { password })` through the privileged tool. `lock` records a reversible **account lock** (migration 0021, `public.account_locks`) and then bans sign-in with `ban_duration`; every identity helper and RPC resolves a locked user to no user, so an already-issued access token is refused immediately. `unlock` lifts the ban and releases the lock. Deactivation (`is_active = false`) is permanent by the preserved `users_update_check` trigger and is never used for a lock. A password change alone revokes nothing; lock first when a session may be compromised. | `updateUserById` examples: "Updates a user's password", "Ban a user for 100 years" (`ban_duration: '876000h'`); Supabase documents that a ban does not revoke issued tokens, hence the application-side lock. |
| No self-registration         | "Allow new users to sign up" disabled in the dashboard; existing users keep signing in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Auth settings documentation.                                                                                                                                                                                  |
| Verified sessions, RLS       | Sign-in on the server with username + password (the server maps the username to the internal address); the session cookie holds Supabase tokens; every request verifies the token (`getClaims`/`getUser`), never trusts `getSession`; PostgREST evaluates RLS from the verified JWT.                                                                                                                                                                                                                                                                                                                                           | Server-side auth guidance: verify tokens on the server; RLS policies read `auth.uid()` / `auth.jwt()`.                                                                                                        |
| MFA                          | TOTP enrolment through Supabase MFA; investigator RPCs already require `aal2` when `require_investigator_mfa` is true (`private.is_investigator()` in schema.sql). No bypass exists; the local shim's `aal` claim is a test-only construct that never reaches Supabase.                                                                                                                                                                                                                                                                                                                                                        | MFA documentation: the `aal` JWT claim; RLS enforcement `(select auth.jwt()->>'aal') = 'aal2'`.                                                                                                               |
| Privileged tooling apart     | `scripts/supabase-admin.mjs` reads a private configuration outside every repository (mode 600) that holds the service-role key; nothing in `src/` imports it, and the web application configuration never carries that key.                                                                                                                                                                                                                                                                                                                                                                                                    | Service-role key handling guidance.                                                                                                                                                                           |

Items to verify on the first staging apply (recorded as UNTESTED until then): that Auth accepts the reserved `.invalid` domain for admin-created confirmed users; the exact Auth Admin REST payloads used by the tool (`POST /auth/v1/admin/users`, `PUT /auth/v1/admin/users/{id}`, `GET /auth/v1/admin/users`) against the current API; session behaviour after `ban_duration`.

## Hardened-project privileges (migration 0022)

The first live staging bootstrap (Codex, 2026-10-22) showed that on a project with automatic table exposure disabled `service_role` holds no table privileges in `public`, and `BYPASSRLS` does not bypass grants: Auth users were created but linking `public.users` through PostgREST returned 403, and the lock table had the same gap. Migration `0022_service_role_admin_grants.sql` grants the administration path the least it needs, to `service_role` only: select/insert/update on `public.users` and `public.account_locks`, select on `reviewers`, `app_schema_version` and `audit_log`, and the identity helpers the triggers call. Nothing is granted to `anon` or `authenticated`, and no delete is granted. The admin tool now checks these privileges before any account mutation and reports `ADMIN_PRIVILEGES_MISSING` by name instead of leaving an Auth-only account. Regression: `tests/service-role-grants.test.ts` (reproduces the gap and the fix on the full lineage with the shim's `service_role`; anon and authenticated stay refused). Applying 0022 to staging is a remote schema change that needs explicit authorization; until then account creation, lock and unlock remain blocked on staging.

Synthetic pilot reviewer accounts: the mapping-confirmation synthetic pilot assigns `SYNTHETIC_PILOT` mappings only to reviewers enrolled with `PILOT` scope, and the schema allows `PILOT` enrolment only for accounts with the immutable flag `is_pilot_test_account = true`. The five existing staging accounts were created with that flag false (formal-scope test identities), so a staging walkthrough of the synthetic pilot needs two additional reviewer accounts with `"isPilotTestAccount": true` in the roster (for example `syn-pilot-reviewer-1`, `syn-pilot-reviewer-2`); the flag is bound into the plan hash. Creating them is a remote mutation that needs explicit authorization.

## Approved target and apply safeguards

The investigator selected a separate synthetic practice project,
`wjntsoeifbelasidssmv`, on 2026-10-23. Both this project and the original completed
pilot project are explicitly allowlisted. Each plan still binds one project,
its database destination, and its roster; allowing the practice project does
not permit mixing its credentials or database URL with the completed pilot.
The original pilot records remain unchanged. Adding this target is preparation,
not authorization to run migrations or create accounts.

On 2026-10-26 the investigator supplied `jsuthraousvtgjpgixdz` as a new, separate
destination for formal-review preparation. It is now explicitly allowlisted,
without changing either earlier target. The configuration still calls this a
`staging` environment until the separate clinical opening is authorized. The
database URI must identify this exact project; a URI for either practice project
is refused. A successful Auth settings check is not evidence that the database
is empty, migrated or ready for review.

`scripts/supabase-readonly-inspect.mjs` also supports a fresh project without
`app_schema_version`. In a read-only transaction it counts non-extension
application objects, Auth accounts and Storage objects, then rolls back. A
missing version marker alone never establishes emptiness: leftover objects are
reported as `UNVERSIONED_OBJECTS_PRESENT`; an absent Auth or Storage table is
reported as unknown (`null`), not zero. This inspection authorizes no mutation.

Generate and review a schema plan only after verifying the new destination.
Account creation is a separate operation: the generic provisioning command
generates passwords for new identities, so it must not be used unchanged where
the investigator has requested preservation of existing passwords. Likewise,
the requested read-only investigator restriction and separate pilot identities
need their own verified account plan before access is issued. Keep the practice
deployment connected to its existing database during preparation.

The privileged tool accepts only the staging references recorded in `APPROVED_STAGING_PROJECT_REFS` (`scripts/supabase-identity-tools.mjs`); a configuration naming any other project is refused before any request, whatever it calls itself. Changing that list requires a reviewed commit. Every mutation also needs `VERIFY_SUPABASE_ADMIN_APPLY=1`, `--apply` (never together with `--dry-run`), `--confirm-project <ref>` and `--plan-sha256` of the plan generated for the same configuration; the plan binds every provisioned field (username, internal address, role, a digest of the display name). Credentials are appended to the private file before each remote creation, so a failure after creation never loses a password; a rerun reconciles an Auth user that lacks its application row and never regenerates a delivered password. `apply-schema` plans against the `app_schema_version` markers of every non-repeatable file (schema.sql through the latest migration; the frozen-trial preflight is the only repeatable file), skips applied files, refuses a partially applied, out-of-order or unknown lineage before writing, and refuses a database destination that differs from the reviewed plan. The credentials path is resolved through real paths, so a symlinked directory inside a repository is refused.

## Hosted-session and account recovery update

The web launcher and hosted startup accept only the independently approved
staging projects. Public origins require HTTPS; HTTP is limited to explicit
loopback hosts for local testing. This does not add a new approved project.

Hosted sessions use an HttpOnly refresh cookie named `verify_sb_refresh_v2`,
scoped to `/api`. Protected API requests can renew an expiring session while a
reviewer is working. A returning browser's older `/api/session` refresh cookie
is migrated by its startup session request and cleared under the old name.
Transient Auth failures leave usable credentials intact and return a retryable
error; successful rotation is returned even if a later data request fails.
Logout confirms revocation, including when only a refresh cookie remains. If
Auth definitively rejects all remaining credentials as invalid, the app clears
local sign-in state without claiming that other sessions were revoked.
Live verification helpers revoke only the session created by that test.

An authorized `accounts --apply` now checks every linked application's identity,
role, immutable pilot flag and active state. It may reconcile the reviewed
display name only, reporting `UPDATED_DISPLAY_NAME`; it does not reset a password,
reactivate an account or change its study role. Interrupted Auth creation can be
resumed without overwriting a different application identity. The plan hashes
the exact display-name bytes, so regenerate and review the plan before applying
with this version. Old plan hashes are not approval for a changed plan.

The mapping-confirmation synthetic import can verify an existing partial set and
resume only missing fixture packets. Assignment retries preserve recorded slots
and the original seed and require active pilot accounts. A mismatched packet,
identity or assignment stops the retry for investigation; existing records are
never replaced. These changes require no database migration. Verification and
deployment status for this increment are recorded in
`docs/test_runs/HOSTED_READINESS_FIXES.md`.

## Bootstrap plan

`node scripts/supabase-admin.mjs plan --config /absolute/private/supabase-admin.json` prints the plan without any remote request:

- target: environment `staging`, project reference and URL from the configuration (must be `https://<ref>.supabase.co`; a production reference must be distinct or null);
- schema: the ordered SQL inputs with SHA-256 and byte counts (`schema.sql`, migrations 0002 to 0039 with the frozen-trial preflight before 0008), the expected final `app_schema_version` (`8.1.4-prepared-sample-intake`, the marker of 0039, which adds atomic preparation in an empty workspace without approvals or assignments; 0038 permits a heading-only revision 4 while preserving revision 3 bindings; 0037 adds an opt-in immutable reviewer guide and versioned bundle 8.3; 0036 adds locked investigator history exports; 0035 adds opt-in subtype observations and probability provenance for new v8.1 designs; 0034 permits explicit fictional identifiers only in synthetic v8 designs and 0033 installs pending requirements; existing v7 practice records and requirements remain unchanged), and the explicit exclusion of `supabase_test_shim/auth_shim.sql`;
- Auth settings to set by hand in the dashboard (sign-ups off, password length, leaked-password protection, TOTP, staging origin only);
- the roster as usernames, internal addresses and roles (no e-mail addresses, no secrets).

The private configuration (`VERIFY_SUPABASE_ADMIN_CONFIG` or `--config`) is a JSON object with exactly `project` (`environment`, `stagingProjectRef`, `productionProjectRef`, `projectUrl`), `serviceRoleKey`, `databaseUrl` (a `postgresql://` URL of the staging project, or `null`) and `accounts` (`username`, `displayName`, `role`). The tool refuses a file inside any Git repository, larger than 64 KiB, or readable by others.

## Secret-free configuration template

Save as a private file outside every repository, `chmod 600`, and point `--config` or `VERIFY_SUPABASE_ADMIN_CONFIG` at it. The private values to obtain from the Supabase dashboard of project `xmuiduugdrqvhssmeacz` (Project Settings → API keys, and Connect → connection string) are marked; nothing else is secret.

```json
{
  "project": {
    "environment": "staging",
    "stagingProjectRef": "xmuiduugdrqvhssmeacz",
    "productionProjectRef": null,
    "projectUrl": "https://xmuiduugdrqvhssmeacz.supabase.co"
  },
  "serviceRoleKey": "<PRIVATE: the service_role secret key (sb_secret_… or the legacy JWT); never the anon or publishable key>",
  "databaseUrl": "<PRIVATE or null: postgresql://postgres.<ref>:<database password>@<pooler host>:5432/postgres; needed only for apply-schema>",
  "databaseCaCertPath": "/absolute/private/path/prod-ca-2021.crt",
  "accounts": [
    {
      "username": "syn-investigator",
      "displayName": "Synthetic investigator",
      "role": "INVESTIGATOR"
    },
    { "username": "syn-reviewer-1", "displayName": "Synthetic reviewer 1", "role": "REVIEWER" },
    { "username": "syn-reviewer-2", "displayName": "Synthetic reviewer 2", "role": "REVIEWER" },
    {
      "username": "syn-adjudicator",
      "displayName": "Synthetic adjudicator",
      "role": "ADJUDICATOR"
    },
    {
      "username": "syn-pilot-reviewer-1",
      "displayName": "Synthetic pilot reviewer 1",
      "role": "REVIEWER",
      "isPilotTestAccount": true
    },
    {
      "username": "syn-pilot-reviewer-2",
      "displayName": "Synthetic pilot reviewer 2",
      "role": "REVIEWER",
      "isPilotTestAccount": true
    }
  ]
}
```

The database URL must name the approved project exactly: `db.<ref>.supabase.co:5432` as user `postgres`, or a Supabase pooler host (`aws-<n>-<region>.pooler.supabase.com`, port 5432 session or 6543 transaction mode) as user `postgres.<ref>`, database `postgres`, no query string. Look-alike hosts are refused, and the non-secret destination (host, port, user, database, mode) is bound into the plan hash.

`databaseCaCertPath` (optional) is the project's CA certificate downloaded from the dashboard (Project Settings → Database → SSL); the runner verifies the server certificate against it in addition to the system store and never disables certificate checks.

Where each private value belongs: the service-role key and the database URL belong only in this file (and in no environment variable of the web application); the anon/publishable key and user access tokens belong only in the separate probe-runner file described in [STAGING_PREFLIGHT.md](STAGING_PREFLIGHT.md); the generated account passwords are written only to the `--credentials-out` file for out-of-band handover.

## Applying (not done in this increment)

Every mutation needs all of: `VERIFY_SUPABASE_ADMIN_APPLY=1`, `--apply`, `--confirm-project <staging ref>`, and `--plan-sha256 <hash printed by plan>` for the same configuration. `accounts --apply` creates the Auth users and the linked `public.users` rows and writes the generated passwords to `--credentials-out` (absolute path outside every repository, created with mode 600, never overwritten). `apply-schema --apply` runs the ordered SQL inputs over the declared database URL on a fresh project only; it refuses a project that already has `public.app_schema_version`. The disposable-database harness (`VERIFY_PG_TEST_URL`) keeps refusing Supabase origins; it is a different tool for a different purpose.

Order for the staging bootstrap, once authorized: (1) dashboard settings; (2) `plan`, review, record the hash; (3) `apply-schema`; (4) `accounts` with a synthetic roster first (`syn-investigator`, `syn-reviewer-1`, `syn-reviewer-2`, `syn-adjudicator`), then the real-JWT probes (`npm run test:supabase:staging -- --config …`); (5) only after the investigator's separate authorization, the real roster. Steps 3 to 5 are not performed in this increment. Status today: tooling prepared and tested against a mocked gateway; no remote request has been made; Supabase behaviour is UNTESTED.

## Application integration (implemented; exercised end to end on staging 2026-10-23)

The web application now has a second deployment mode, `VERIFY_DATA_BACKEND=supabase`, started with `node scripts/supabase-web.mjs start --config <private web-app.json>` (template: `~/Private/civicsample-verify-staging/web-app.json`; it holds the **publishable** key only, and the launcher refuses a placeholder or a secret key). The default mode, the local PGlite pilot, is unchanged.

| Piece                                                                                                                                                                                                                                                                                          | Implemented                                                                                                              | Verified                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Username + password sign-in through Supabase Auth (`POST /auth/v1/token?grant_type=password`), username mapped to the internal address, never echoed                                                                                                                                           | `src/lib/supabase-auth.ts`, `/api/session`                                                                               | Locally against a fake Auth gateway (`tests/supabase-web.test.ts`). Real Supabase: UNTESTED until the publishable key is configured (`tests/staging-live.test.ts`).      |
| HttpOnly cookie sessions (`verify_sb_access` site-wide, `verify_sb_refresh` scoped to `/api/session`, `Secure` on https), access token verified with Auth on every request (`GET /auth/v1/user`, cached 30 s), server-side refresh before expiry, logout (`POST /auth/v1/logout?scope=global`) | `src/server/session.ts`                                                                                                  | Local fake gateway. Real: UNTESTED.                                                                                                                                      |
| Application identity from the database under the user's token (`rpc_whoami`, own `users` row), so a locked or inactive account resolves to no user                                                                                                                                             | `src/server/session.ts`                                                                                                  | Local fake gateway. Real: UNTESTED.                                                                                                                                      |
| Mapping-confirmation reads through PostgREST views/tables and writes through `rpc_mc_*` under the user's token (RLS decides)                                                                                                                                                                   | `src/server/mapconf-rest.ts`, `src/lib/postgrest.ts`                                                                     | DTO contract shared with the local module; route-level test with a fake gateway. Real: UNTESTED.                                                                         |
| Investigator TOTP: enrol (`POST /auth/v1/factors`), challenge, verify (`/factors/{id}/verify`) → aal2 session; investigator routes and the database (`require_investigator_mfa`) refuse aal1                                                                                                   | `/api/mfa/enroll`, `/api/mfa/verify`, `src/app/mfa-panel.tsx`                                                            | Local fake gateway (enrol, wrong code, verify, aal2). Real: UNTESTED; enrolment of the synthetic investigator is done by you in the browser with your authenticator app. |
| Origin check for mutations against the configured site origin                                                                                                                                                                                                                                  | route handler                                                                                                            | Local test.                                                                                                                                                              |
| Not served in this mode                                                                                                                                                                                                                                                                        | the local synthetic pilot (`/api/workspace`, `/api/cases`, `/api/admin`) and the v5 trial-verification routes return 503 | Local test.                                                                                                                                                              |

The browser never receives a Supabase token (no client-side Supabase library); the secret key and the database password are never configuration of the web application. A reviewer who is locked (`account_locks`) or deactivated resolves to no application user and is signed out.

## Staging prerequisites still needed

1. **Publishable key** in the private `web-app.json` (dashboard: Project Settings → API Keys → _Publishable key_, `sb_publishable_…`). It is safe in server and browser code and runs as `anon`/`authenticated` under RLS; the _secret_ key (`sb_secret_…`) runs as `service_role` and belongs only in `supabase-admin.json`.
2. **Sign-ups disabled** (dashboard: Authentication → Sign In / Providers → Email → "Allow new users to sign up" off). The read-only settings check currently shows sign-ups enabled.
3. **Migration 0022 applied** (authorization needed; `apply-schema` resumes), after which `accounts`, `lock` and `unlock` work on staging.
4. **Two synthetic pilot reviewer accounts** (`isPilotTestAccount: true`; authorization needed) so `SYNTHETIC_PILOT` mappings can be assigned.
5. **TOTP enrolment** of the synthetic investigator through the app, by you, with your authenticator app. Done 2026-10-23.
6. **Synthetic pilot import** on staging, from the reviewed plan (`node --import tsx scripts/mapconf-import-plan.mjs`), after your authorization. Done 2026-10-23 (see the verification section).

## Verification of this increment

Local (fake Auth/PostgREST gateway): `npm run check` PASS (154 passed, 0 failed, 15 skipped: 13 native PostgreSQL BLOCKED locally, 2 real-staging BLOCKED without private files); `npm run build` PASS (6 manifests, 24 SQL inputs); `npm run test:e2e:production` PASS (4 scenarios); formatting and whitespace clean. Hosted CI at `5a5de0b`: web, analysis and postgres:16 jobs success, 12/12 native tests.

Real Supabase staging (`xmuiduugdrqvhssmeacz`), after the publishable key was placed in the private web configuration (2026-10-22): `npm run supabase:web -- check` OK (sign-ups still ENABLED on the project); `npm run test:supabase:live` PASS, 2 tests: every synthetic account signs in by username through Supabase Auth, verifies with `GET /auth/v1/user`, resolves its application role through `rpc_whoami` over PostgREST and reads its own `users` row; sign-out invalidates the token; anonymous requests are refused on `users`, `mc_cases`, `mc_responses` and `reviewers`; a reviewer sees only their own user row and no responses and cannot call `rpc_mc_phase`; the adjudicator cannot create a campaign; the investigator at aal1 is refused by `rpc_mc_completion_summary` (`require_investigator_mfa`). Browser smoke against the served app in Supabase mode: a wrong password is refused, a reviewer signs in and sees the mapping tab (empty queue: nothing imported), the access cookie is HttpOnly, no key, token or password appears in the page, sign-out clears the session, and the investigator signs in at aal1 and is shown the second-factor panel (enrolment left to the investigator) while an admin action returns 403.

Migration 0022 on staging (2026-10-22, authorized by the investigator against plan `74b0f7b7…bd87`): `apply-schema` reported 21 `ALREADY_APPLIED`, the repeatable preflight ran, and `0022_service_role_admin_grants.sql` was the only file applied; the lineage holds 22 markers ending at `6.0.4-service-role-admin-grants`. Read-only verification afterwards: `service_role` now holds SELECT/INSERT/UPDATE on `public.users` and `public.account_locks` and SELECT on `reviewers`, `app_schema_version` and `audit_log`; `anon` holds no privilege on these tables and `authenticated` holds SELECT only (unchanged, RLS applies); the helper functions execute for `service_role` and, where they did before, for `authenticated`, never for `anon`; the tool's privilege check passes through PostgREST; the five Auth accounts are unchanged (confirmed, not banned, no factors, five linked active application rows, no pilot flag); the real sign-in and denial suite still passes. Observation for a later additive migration: the project's defaults already gave `service_role` REFERENCES, TRIGGER and TRUNCATE on these tables before 0022; `account_locks` refuses truncation by trigger, `users` does not. Revoking TRUNCATE from `service_role` is recommended but was not part of the authorized change.

Accounts on staging (2026-10-22, authorized against the same plan): `accounts --apply` reconciled the five existing accounts as `EXISTS_LINKED` (no password change) and created `syn-pilot-reviewer-1` and `syn-pilot-reviewer-2` (`REVIEWER`, `is_pilot_test_account = true`, confirmed, linked, active); their generated passwords were written only to the private credentials file. Seven Auth users, none banned; the real sign-in suite passes for all seven.

Historical PR #11 preparation record (superseded by the private apply reports and current generated plan): `0023_service_role_truncate_revoke.sql` revokes TRUNCATE, REFERENCES and TRIGGER from `service_role` on every public table (and by default privilege on later tables) while keeping the 0022 administration grants; `tests/service-role-truncate.test.ts` reproduces the project-default privileges and checks the revoke, the unchanged `anon`/`authenticated` privileges and the surviving administration read.

Full synthetic workflow on staging (2026-10-23, each step authorized by the investigator and performed through the served app at `http://127.0.0.1:3300/`, never through the service-role key): the investigator enrolled a TOTP authenticator in the browser (Auth Admin read afterwards: exactly one verified factor on `syn-investigator-1`, no abandoned factor, no factor on any other account, so reviewers and the adjudicator are never asked for a second factor); the investigator created the campaign (`CONDSET-PPR-FIG2-v5.1-PROPOSED`, status PROPOSED, rubric `MAPPING_CONFIRMATION_RUBRIC-DRAFT-1`), imported the 12 `SYNTHETIC_PILOT` and 3 `TRAINING_EXAMPLE` cases from the reviewed plan and assigned them (24 assignments, seed 20261022, both pilot accounts enrolled with PILOT scope); the two pilot reviewers submitted 24 final answers through `/api/session` + `/api/mc/assignments/{id}/submit` (reviewer 2 refused `MC-SYN-011` with an annotation; both marked `MC-SYN-012` insufficient); neither reviewer's workspace carried the other's annotation, and both received 403 on the investigator route; the investigator closed submissions and authorized adjudication with attestations; the adjudicator recorded `DISCORDANT_RESOLVED` (NO, basis REVIEWER_2) for `MC-SYN-011` and `RUBRIC_ADDITION_REVIEWED` (no decision, basis NONE) for `MC-SYN-012`; the investigator locked the campaign, built the export and registered it (manifest `f34b9b54…`, `app_git_sha` 7107b71; three identical registration rows because the button was pressed three times, which the interface now prevents). Read-only database checks after each step: phase OPEN → CLOSED → ADJUDICATION → LOCKED, `mc_cases` 12 + 3, `mc_assignments` 24, `mc_responses` 24, `mc_adjudications` 2, `mc_exports` 3. Two defects found and fixed during the run: Auth returns the TOTP QR as raw SVG markup (now accepted and rendered inline), and an enrolled investigator signing in again was asked to type the authenticator's internal id (the server now finds the verified factor from the code alone). Export from a build made on a dirty tree was refused with "Export requires a verified application build commit", as designed; the rebuild from the clean tree at 7107b71 exported.

Historical PR #11 preparation record (superseded by the private apply reports and current generated plan): `0024_v7_mapping_units.sql` (review design v7, the supplied migration byte-identical; draft PR #8), `0025_v7_review_fixes.sql` and `0026_v7_lifecycle_and_gates.sql` (fixes to 0024; draft PR #9), `0027_service_role_least_privilege.sql`, `0028_v7_gate_specifications_v8_1.sql`, `0029_v7_versioned_gate_approvals.sql` and `0030_v7_current_unit_freeze_gates.sql` (draft PR #11). Staging today ends at `6.0.4-service-role-admin-grants`; a plan generated from this branch lists 0023 to 0030 as the files to apply and `7.0.5-v7-current-unit-freeze-gates` as the expected final marker, and must not be authorized before the v7 review findings are resolved (`docs/test_runs/V7_MIGRATION_REVIEW.md`). Later branches add fix migrations and move the expected marker with them; the plan, not this paragraph, is the authority for an apply.

Still UNTESTED on staging: migrations 0023 to 0030 (prepared only) and the reversible account lock/unlock on a synthetic account (awaits authorization to lock one briefly).

## What the investigator needs to provide

A private local path (outside every repository, mode 600) for the admin configuration described above. Do not paste keys into chat or into the repository; the tool reads the file and never prints its contents.

For restricted practice oversight introduced in 0031, see [PRACTICE_OBSERVER.md](PRACTICE_OBSERVER.md). The restriction is account-specific and preserves all existing review data.
