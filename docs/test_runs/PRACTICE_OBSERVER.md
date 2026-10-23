# Practice observer verification — 2026-10-23

The authorized practice account was restricted to progress counts and synthetic worked examples. Existing roles, passwords, Auth factors, review records and other accounts were preserved. Migration 0031 is additive and does not itself restrict any account.

Executed checks:

- `npm run check` with the configured analysis Python: 231 tests passed, zero failed, 30 environment skips and one pre-existing proposal TODO; typecheck and lint passed. Source/fixture leakage scans are part of this command.

- Full-lineage PGlite: observer completion counts and three examples at aal1 and aal2; raw judgments, queues, reference and audit reads hidden; import, assignment, phase changes, reference lock and account registration refused; self-escalation refused; lock honored; restoring full access still requires MFA. PASS.
- Route allowlist: only the observer GET endpoint is allowed beyond session login/logout. PASS.
- Production build: PASS, 33 SQL inputs and no local runtime files in the trace.
- Served production browser checks: 4/4 PASS, including view-only navigation without MFA or administrative controls (mock session).
- Real practice Supabase through the local production web build: password-only sign-in, 12 assigned units per reviewer and three worked examples visible, administrative requests denied. Direct PostgREST judgment/audit/queue reads empty; lock RPC and self-escalation denied. PASS. No review answers written.
- Public Render with this new build: pending owner redeployment. Its previous build still presents the investigator MFA screen; the database restriction already denies administrative actions.

The first broad check caught two stale lineage expectations after adding 0031 (the operator documentation and a version-array length). Both were updated to retain the previous markers and append the new marker; their nine targeted tests passed. No security assertion was removed.

Private apply/access verification records and the account-specific screenshot remain outside the repository. Local native PostgreSQL and unrelated external-service tests remain skipped when their environments are unavailable; PGlite is not reported as native PostgreSQL. The direct PostgREST checks above used the actual practice project.
