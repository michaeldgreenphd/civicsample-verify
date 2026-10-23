# Separate practice project preflight — 2026-10-23

The investigator selected a new, separate Supabase project for synthetic practice.
Only read-only remote checks were performed. No migration, account creation,
import, gate approval, invitation, or Render configuration change occurred.
The existing completed pilot was not changed.

## Observed checks

- Private admin and web configuration: valid and owner-only; credentials omitted.
- Downloaded database CA: installed in the private configuration directory;
  the source download was preserved.
- Public Auth settings: publishable key accepted, email provider enabled,
  public sign-ups disabled.
- Auth Admin list: secret key accepted; zero existing accounts.
- PostgreSQL: connection succeeded with certificate verification enabled.
  Read-only transaction found zero public tables and no app schema marker.
- Private bootstrap plan: 31 SQL inputs (including the repeatable preflight),
  final schema version `7.0.5-v7-current-unit-freeze-gates`, five separate accounts.
  The roster, plan, credentials, and database connection remain outside Git.

## Executed local verification

- `node --import tsx --test tests/supabase-identity.test.ts`: PASS, 8 tests,
  including rejection of the old pilot's database URL for the new practice project.
- `npm run check` with `VERIFY_ANALYSIS_PYTHON` pointing to the existing local
  analysis virtual environment: PASS; 258 tests, 227 passed, zero failures,
  30 skipped and one TODO. Native PostgreSQL and opt-in live suites were not
  run by this command. All source/fixture and v4/v5/v7 leakage scans passed.
- `npm run build`: PASS, seven production manifests and 32 SQL inputs checked.
- Prettier on changed implementation, tests and identity documentation: PASS.
- `git diff --check`: PASS.

This preparatory change affects administrative destination validation only;
browser behavior is unchanged. No new browser run was performed. The successful
database connection is not a deployed authorization or workflow acceptance test.
Full new-project role and workflow checks remain pending schema installation.
