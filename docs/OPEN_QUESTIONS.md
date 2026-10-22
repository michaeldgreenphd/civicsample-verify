# Decisions and integration work still open

## Investigator decisions

The Tier 1 version (`v1.1` vs `v1.2`), proposed 100-case formal sample adequacy/inference target (distinct from the 96-case synthetic fixture bundle in `analysis/fixtures/make_synthetic_v4_bundle.py`), frozen rubric, adjudicator identity, analysis plan and treatment of indeterminate judgments remain unapproved. The proposed sample's weak coverage of Tier 0-negative/Tier 1-positive (`FX_GAIN` `ONEG_CPOS`, `n = 1` in the synthetic fixture) cases remains an explicit blocking warning (`RETAIN_100_WITH_EXPLICIT_COVERAGE_LIMITATION` vs `ADOPT_EXTENSION_30` vs `REDESIGN_BEFORE_REVIEW`). Hosting region, retention and Module B scope need separate decisions. No application action substitutes for these approvals.

## Direct request takes precedence over attached source

The latest user request requires locked final submissions and explicit audited amendments; the supplied handoff permits ordinary revisions until close. The application follows the stricter request. It requires rationale for every final decision, although the attached contract treats some rationale as recommended. It requires two completed independent reviewers before adjudication; the supplied formal path also describes single-review adjudication. These distinctions are enforced by the synthetic extension and tested. The original historical schema remains unchanged, so formal integration must reconcile them with an additive migration before exposure to clinician accounts.

The handoff recommends a Python frontend; the user prefers Next.js. This build uses Next.js and TypeScript with the supplied PostgreSQL lineage and separate Python analysis. Clinical semantic rules and proposed analysis methods are not approved merely because their synthetic tests pass.

## Remaining engineering work

- Replace the local synthetic invite/JWT test scaffolding (`src/lib/auth.ts`: single-use invite tokens, explicit `aal2` claim enforcement without default-to-`aal2`, HS256 JWT verification, and permanent session revocation across re-invites; not implemented TOTP/MFA) with a verified external identity provider (e.g., isolated Supabase Auth/PostgREST staging with real MFA) once provisioned and authorized.
- Extend canonical synthetic pilot case authoring (`rpc_verify_author_case` and `authorSyntheticPilotCase` in `src/server/admin-workflows.ts`, plus the investigator case-authoring UI in `src/app/page.tsx`) to multi-campaign administration screens only after investigator approval of formal study workflow rules.
- Connect approved rubric/version registration, sample provenance review, private import, freeze and formal lifecycle screens to the historical schema with the stricter final-submission contract; `evaluateApprovalGates` (`src/server/admin-workflows.ts`) currently inspects all 11 approval gates from `docs/APPROVAL_GATES.md` and keeps `formalActivationAllowed: false` until all scientific approvals and deployment verifications exist.
- Database-to-exporter-to-Python integration (`exportV4SyntheticBundleFromDb` in `src/lib/formal-export.ts`) is now implemented and tested against live database views (`v_independent_judgments_v4`, `v_adjudicated_reference_v4`, `v_frozen_predictions_v4`) and verification RPCs (`rpc_verify_frozen_predictions_v4`, `rpc_verify_judgment_snapshot_v4`) using synthetic records; running it on formal study records remains blocked pending formal study approval.
- Run the native PostgreSQL multi-session concurrency harness (`tests/postgres-native.test.ts`, which uses `pg` and creates/tears down a disposable `verify_disp_...` database without touching schemas in the supplied database) in hosted GitHub Actions (`postgres:16` service job) or on a host with a local PostgreSQL 16 server (`VERIFY_PG_TEST_URL`), and run separate live Supabase JWT/PostgREST table/view/RPC boundary tests against a provisioned staging deployment.
- Complete screen-reader/manual keyboard testing, mobile form usability review, sustained load/latency measurements, backup/restore and operational logging/retention checks.

The optional Module B remains a separate proposed UI entry point and supplied schema/test surface; it has no active application review workflow. Adjudication forms currently retain unsent edits only in the current view and disclose that limitation.
