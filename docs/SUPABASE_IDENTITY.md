# Supabase identity and staging bootstrap (prepared, not applied)

Status: **prepared with synthetic tests only.** No account was created, no schema was applied, no invitation was sent and no credential exists in this repository. The staging project `civicsample-verify-staging` (reference `xmuiduugdrqvhssmeacz`) is the only remote target the tooling accepts, and only when a private configuration names it.

## Requirements (investigator, 2026-10-22)

Individually assigned usernames and passwords; no personal e-mail address from any reviewer; investigator-managed resets; verified user sessions with permissions enforced by database RLS/RPCs and server checks; no service-role key in the web application; no custom password storage, shared account, fabricated JWT claim or MFA bypass; privileged provisioning and reset tooling separate from the web app.

## Design, checked against the Supabase documentation

| Requirement                  | Design                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Documentation basis                                                                                                                                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Username, no personal e-mail | Supabase Auth has no username provider; each username maps to an internal, never-deliverable address `<username>@<project-ref>.accounts.invalid` (RFC 2606 reserved domain). The account is created by the privileged tool with `email_confirm: true`, so no message is ever sent.                                                                                                                                                                                                                              | `auth.admin.createUser({ email, password, email_confirm: true })` is server-only ("Never expose your service_role key in the browser"); admin changes "are applied directly without confirmation flows".                                                                                       |
| Passwords                    | Supabase stores and checks passwords; the tool only generates a random 32-character password once and writes it to a private file for out-of-band handover. Minimum length and leaked-password protection are dashboard settings.                                                                                                                                                                                                                                                                               | Auth password policy settings; no application code stores or hashes passwords.                                                                                                                                                                                                                 |
| Investigator-managed resets  | `reset-password` calls `auth.admin.updateUserById(id, { password })` through the privileged tool. `lock` sets `ban_duration` **and** deactivates the application row (`public.users.is_active = false`), because Supabase documents that a ban does not revoke issued access tokens; every RLS helper and RPC checks `is_active`, so a locked account's existing session is refused immediately. `unlock` reverses both. A password change alone revokes nothing; lock first when a session may be compromised. | `updateUserById` examples: "Updates a user's password", "Ban a user for 100 years" (`ban_duration: '876000h'`). `auth.admin.signOut(jwt, scope)` needs the user's JWT, so the tool cannot revoke sessions on its own; deactivating the application row closes the window for this application. |
| No self-registration         | "Allow new users to sign up" disabled in the dashboard; existing users keep signing in.                                                                                                                                                                                                                                                                                                                                                                                                                         | Auth settings documentation.                                                                                                                                                                                                                                                                   |
| Verified sessions, RLS       | Sign-in on the server with username + password (the server maps the username to the internal address); the session cookie holds Supabase tokens; every request verifies the token (`getClaims`/`getUser`), never trusts `getSession`; PostgREST evaluates RLS from the verified JWT.                                                                                                                                                                                                                            | Server-side auth guidance: verify tokens on the server; RLS policies read `auth.uid()` / `auth.jwt()`.                                                                                                                                                                                         |
| MFA                          | TOTP enrolment through Supabase MFA; investigator RPCs already require `aal2` when `require_investigator_mfa` is true (`private.is_investigator()` in schema.sql). No bypass exists; the local shim's `aal` claim is a test-only construct that never reaches Supabase.                                                                                                                                                                                                                                         | MFA documentation: the `aal` JWT claim; RLS enforcement `(select auth.jwt()->>'aal') = 'aal2'`.                                                                                                                                                                                                |
| Privileged tooling apart     | `scripts/supabase-admin.mjs` reads a private configuration outside every repository (mode 600) that holds the service-role key; nothing in `src/` imports it, and the web application configuration never carries that key.                                                                                                                                                                                                                                                                                     | Service-role key handling guidance.                                                                                                                                                                                                                                                            |

Items to verify on the first staging apply (recorded as UNTESTED until then): that Auth accepts the reserved `.invalid` domain for admin-created confirmed users; the exact Auth Admin REST payloads used by the tool (`POST /auth/v1/admin/users`, `PUT /auth/v1/admin/users/{id}`, `GET /auth/v1/admin/users`) against the current API; session behaviour after `ban_duration`.

## Approved target and apply safeguards

The privileged tool accepts only the staging reference recorded in `APPROVED_STAGING_PROJECT_REFS` (`scripts/supabase-identity-tools.mjs`, currently `xmuiduugdrqvhssmeacz`); a configuration naming any other project is refused before any request, whatever it calls itself. Changing that list requires a reviewed commit. Every mutation also needs `VERIFY_SUPABASE_ADMIN_APPLY=1`, `--apply` (never together with `--dry-run`), `--confirm-project <ref>` and `--plan-sha256` of the plan generated for the same configuration; the plan binds every provisioned field (username, internal address, role, a digest of the display name). Credentials are appended to the private file before each remote creation, so a failure after creation never loses a password; a rerun reconciles an Auth user that lacks its application row and never regenerates a delivered password. `apply-schema` resumes by `app_schema_version` markers and refuses a partially applied or out-of-order lineage. The credentials path is resolved through real paths, so a symlinked directory inside a repository is refused.

## Bootstrap plan

`node scripts/supabase-admin.mjs plan --config /absolute/private/supabase-admin.json` prints the plan without any remote request:

- target: environment `staging`, project reference and URL from the configuration (must be `https://<ref>.supabase.co`; a production reference must be distinct or null);
- schema: the ordered SQL inputs with SHA-256 and byte counts (`schema.sql`, migrations 0002 to 0018 with the frozen-trial preflight before 0008), the expected final `app_schema_version` (`6.0.1-mapping-confirmation-review-fixes`), and the explicit exclusion of `supabase_test_shim/auth_shim.sql`;
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
  "accounts": [
    {
      "username": "syn-investigator",
      "displayName": "Synthetic investigator",
      "role": "INVESTIGATOR"
    },
    { "username": "syn-reviewer-1", "displayName": "Synthetic reviewer 1", "role": "REVIEWER" },
    { "username": "syn-reviewer-2", "displayName": "Synthetic reviewer 2", "role": "REVIEWER" },
    { "username": "syn-adjudicator", "displayName": "Synthetic adjudicator", "role": "ADJUDICATOR" }
  ]
}
```

Where each private value belongs: the service-role key and the database URL belong only in this file (and in no environment variable of the web application); the anon/publishable key and user access tokens belong only in the separate probe-runner file described in [STAGING_PREFLIGHT.md](STAGING_PREFLIGHT.md); the generated account passwords are written only to the `--credentials-out` file for out-of-band handover.

## Applying (not done in this increment)

Every mutation needs all of: `VERIFY_SUPABASE_ADMIN_APPLY=1`, `--apply`, `--confirm-project <staging ref>`, and `--plan-sha256 <hash printed by plan>` for the same configuration. `accounts --apply` creates the Auth users and the linked `public.users` rows and writes the generated passwords to `--credentials-out` (absolute path outside every repository, created with mode 600, never overwritten). `apply-schema --apply` runs the ordered SQL inputs over the declared database URL on a fresh project only; it refuses a project that already has `public.app_schema_version`. The disposable-database harness (`VERIFY_PG_TEST_URL`) keeps refusing Supabase origins; it is a different tool for a different purpose.

Order for the staging bootstrap, once authorized: (1) dashboard settings; (2) `plan`, review, record the hash; (3) `apply-schema`; (4) `accounts` with a synthetic roster first (`syn-investigator`, `syn-reviewer-1`, `syn-reviewer-2`, `syn-adjudicator`), then the real-JWT probes (`npm run test:supabase:staging -- --config …`); (5) only after the investigator's separate authorization, the real roster. Steps 3 to 5 are not performed in this increment. Status today: tooling prepared and tested against a mocked gateway; no remote request has been made; Supabase behaviour is UNTESTED.

## Application integration (remaining)

The web application still runs on the local PGlite database with the local session cookie. Hosting it on Supabase needs: a server-side sign-in route that maps username to the internal address and calls Supabase Auth with the anon/publishable key only; cookie sessions with token verification on every request; the data layer calling `rpc_*` functions and views through PostgREST with the user's token instead of `withActor`; TOTP enrolment screens; and the real-JWT acceptance runs listed in [STAGING_PREFLIGHT.md](STAGING_PREFLIGHT.md). Those are separate increments after the bootstrap plan is approved. The read-only probe runner now also covers the mapping-confirmation tables (`mapping_confirmation_isolation`), using an optional synthetic `mappingCaseId` positive control.

## Verification of this increment (local, synthetic)

`npm run check` PASS (139 passed, 0 failed, 11 native PostgreSQL tests skipped as BLOCKED; second round after the Codex review of PR #7); `npm run build` PASS (6 manifests, 20 SQL inputs); `npm run test:e2e:production` PASS (4 scenarios); `npm run format:check` and `git diff --check` PASS; `node scripts/supabase-admin.mjs plan` without a configuration reports BLOCKED (`PRIVATE_ADMIN_CONFIG_UNAVAILABLE`, exit 2) and makes no request. Supabase itself: UNTESTED; no remote request was made by any test.

## What the investigator needs to provide

A private local path (outside every repository, mode 600) for the admin configuration described above. Do not paste keys into chat or into the repository; the tool reads the file and never prints its contents.
