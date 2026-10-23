# Shared synthetic practice website: readiness and hosting plan

Status: **not deployed, not ready to deploy.** This document records an inspection of the code at the PR #11 head (2026-10-23) and what remains before a shared practice website can run against the Supabase staging project. It authorizes nothing: no hosting account, purchase, deployment, invitation, real record or formal review. Local tests and the staging pilot do not establish deployment readiness; only the checks in section 5, run on the deployed URL, can.

## 1. What a hosted instance would run

The hosted instance is the Supabase deployment mode (`VERIFY_DATA_BACKEND=supabase`), the same production build that the staging pilot uses locally on port 3400:

- **Sign-in**: usernames map to internal addresses; the server signs in through Supabase Auth (GoTrue REST) and keeps the session in HttpOnly cookies (`verify_sb_access`, and `verify_sb_refresh` scoped to `/api/session`, SameSite=Strict, `Secure` when the site origin is `https://`). The access token is verified with Auth on each request and refreshed server-side. Investigators need a verified TOTP factor (aal2) for investigator actions.
- **Data**: every read and write goes through PostgREST under the caller's own token; row-level security and `rpc_*` functions decide access. The web process holds only the publishable key; a secret key is refused at startup (`src/lib/supabase-config.ts`).
- **Routes served**: multi-factor enrolment and verification, the mapping-confirmation routes (`/api/mc/*`) and the review design v7 routes (`/api/mu7/*`). The local-only pilot routes (v2/v4/v5 and the local tools) are not served in this mode (`withSupabaseActor`, `src/app/api/[...path]/route.ts`).

## 2. Process-local and local-database state

| State                                                         | Where                                                                                            | Used in Supabase mode?                                           | Hosted consequence                                                                                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PGlite database (`VERIFY_DB_DIR`, default `.local/pglite`)    | `src/server/db.ts`                                                                               | No: only the local routes and `src/server/mu7.ts` call `getDb()` | None, provided the mode is set. The package still contains PGlite (`serverExternalPackages`); it is never opened.                                                                                        |
| Local sessions, invites, revocations, sign-in attempt counter | `globalThis` maps in `src/lib/auth.ts`                                                           | No                                                               | None. Sign-in throttling in Supabase mode is Auth's own rate limit (HTTP 429 passed through).                                                                                                            |
| Auth verification cache, 30 s per access token                | `SupabaseAuth.cache` in `src/lib/supabase-auth.ts`                                               | Yes                                                              | Per instance only. A lock or ban takes effect within 30 s on each instance; acceptable for practice, to be stated in the reviewer instructions.                                                          |
| Supabase configuration and Auth client                        | `globalThis` in `src/server/session.ts`                                                          | Yes                                                              | Read once from the environment per process; a configuration change needs a restart.                                                                                                                      |
| Build identity                                                | baked at build time (`scripts/build-identity.mjs`, clean Git tree only), or `VERIFY_APP_GIT_SHA` | Yes (exports attest to it)                                       | A host that builds without `.git` or from a dirty tree yields `unverified-local-build`, and exports must not be registered. Set `VERIFY_APP_GIT_SHA` to the deployed commit or build from a clean clone. |
| Files                                                         | `src/server/tlv5.ts` reads an optional worked-examples file (local mode only)                    | No                                                               | No writable disk is needed; an ephemeral filesystem is fine.                                                                                                                                             |

Conclusion: in Supabase mode the application keeps no state that must survive a restart, and nothing depends on the local disk. Several instances could serve it, with the 30 s revocation window above.

## 3. Changes required before a hosted deployment

1. **Hosted start command.** `npm start` binds `127.0.0.1`, and `scripts/supabase-web.mjs start` always sets `VERIFY_SITE_ORIGIN` to `http://127.0.0.1:<port>` (the port defaults to 3300), so neither works on a host. Add a hosted start path (for example `next start --hostname 0.0.0.0 --port "$PORT"`) that takes the variables of section 4 from the host environment, refuses to start unless `VERIFY_DATA_BACKEND=supabase` and `VERIFY_SITE_ORIGIN` is an `https://` origin, and refuses a secret key (already enforced).
2. **Origin and cookies behind the host's proxy.** Mutations are accepted only when `Origin` equals `VERIFY_SITE_ORIGIN`; with an `https://` origin cookies are `Secure`. Test both on the deployed URL (section 5), including the refresh cookie path.
3. **Content Security Policy.** `next.config.ts` allows `'unsafe-eval'` and `'unsafe-inline'` for scripts. Check whether the production build needs them; tighten if not (nonce-based CSP otherwise).
4. **Logging.** Confirm the host's request logs record no request or response bodies and no cookies; the application itself logs no payloads.
5. **Build identity.** Configure the host to build from a clean clone at the reviewed commit, or set `VERIFY_APP_GIT_SHA`; refuse to register an export whose build is `unverified-local-build`.
6. **Auth settings.** Keep sign-ups disabled (checked by `supabase-web.mjs check`). Add the deployed origin to the Auth site URL and redirect allow-list only if a flow needs it (the current flows do not redirect).
7. **Supabase Data API change, 2026-10-30.** From that date, tables created in `public` on existing projects are no longer granted to the Data API automatically ([changelog](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)). Existing objects keep their grants. The v7 tables already revoke and grant explicitly (0024), so nothing breaks today, but every future migration must grant explicitly, and a test should assert the grants of each table the application reads.
8. **Keep the pause in mind.** A Free Supabase project pauses after 7 days without database activity and must be restored from the dashboard. Practice periods longer than a week without use need a restore step, or a paid plan (not authorized).

## 4. Environment variables (names only)

| Variable                             | Value                                                         |
| ------------------------------------ | ------------------------------------------------------------- |
| `VERIFY_DATA_BACKEND`                | `supabase`                                                    |
| `VERIFY_SUPABASE_URL`                | `https://<project-ref>.supabase.co`                           |
| `VERIFY_SUPABASE_PUBLISHABLE_KEY`    | the publishable (or legacy anon) key; never a secret key      |
| `VERIFY_SUPABASE_ACCOUNT_DOMAIN_REF` | the project reference used for internal account addresses     |
| `VERIFY_SITE_ORIGIN`                 | the deployed `https://` origin, exactly                       |
| `VERIFY_APP_GIT_SHA`                 | the 40-character deployed commit, if the build cannot bake it |
| `NEXT_TELEMETRY_DISABLED`            | `1`                                                           |
| `PORT`                               | provided by the host                                          |

Never on the host: the database URL or password, the service-role or secret key, any account password, the CA file of the database connection (the web process does not connect to the database directly).

## 5. Verification on the deployed URL (none run yet)

1. `supabase-web.mjs check` against the deployed configuration: sign-ups disabled.
2. Sign-in of each synthetic role in separate browser profiles; investigator TOTP; refusal of investigator actions at aal1.
3. Cross-origin mutation refused; cookies `HttpOnly`, `Secure`, `SameSite=Strict`; refresh after expiry; sign-out.
4. The live v7 restriction and reviewer-isolation phases (`tests/staging-live-v7.test.ts`) with `VERIFY_SITE_ORIGIN` set to the deployed origin.
5. Account lock then unlock of one synthetic account, observing the ≤30 s window.
6. Response headers (CSP, `X-Frame-Options`, `nosniff`, no `X-Powered-By`) and a dependency audit of the deployed build.
7. Host logs inspected for payloads, cookies or tokens.

## 6. Hosting options (checked 2026-10-23; terms change, recheck before choosing)

| Option                                                                         | Free-plan terms that matter                                                                                                                                                                                                                                                                            | Fit                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Render, Free web service** ([docs](https://render.com/docs/free))            | Long-running Node process; spins down after 15 min without inbound traffic, about one minute to wake; 750 free instance hours per workspace per month, then suspended until the next month; ephemeral filesystem; managed TLS and custom domains; Render says not to use Free instances for production | **Recommended for the practice site.** It runs the same `next start` server that the local production tests exercise, needs no adapter, and the application needs no disk. The wake-up delay and the production caveat are acceptable for synthetic practice only. |
| Vercel, Hobby ([fair use](https://vercel.com/docs/limits/fair-use-guidelines)) | Restricted to non-commercial **personal** use; resource caps per month; serverless functions                                                                                                                                                                                                           | Native Next.js support, but a shared multi-person research site may not count as personal use. Eligibility should be confirmed with Vercel before use.                                                                                                             |
| Paid hosting (any)                                                             | Not authorized                                                                                                                                                                                                                                                                                         | Needed for formal clinical review in any case, together with a Supabase plan that does not pause and has provider backups.                                                                                                                                         |

The formal clinician review is a separate decision: it needs its own approval gates, a hosting and region decision, retention, backups that are tested end to end (Auth included), and none of the Free-plan caveats above.
