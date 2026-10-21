# Decisions and integration work still open

## Investigator decisions

The Tier 1 version, sample adequacy/inference target, frozen rubric, adjudicator identity, analysis plan and treatment of indeterminate judgments remain unapproved. The proposed sample's weak coverage of Tier 0-negative/Tier 1-positive cases remains an explicit blocking warning. Hosting region, retention and Module B scope need separate decisions. No application action substitutes for these approvals.

## Direct request takes precedence over attached source

The latest user request requires locked final submissions and explicit audited amendments; the supplied handoff permits ordinary revisions until close. The application follows the stricter request. It requires rationale for every final decision, although the attached contract treats some rationale as recommended. It requires two completed independent reviewers before adjudication; the supplied formal path also describes single-review adjudication. These distinctions are enforced by the synthetic extension and tested. The original historical schema remains unchanged, so formal integration must reconcile them with an additive migration before exposure to clinician accounts.

The handoff recommends a Python frontend; the user prefers Next.js. This build uses Next.js and TypeScript with the supplied PostgreSQL lineage and separate Python analysis. Clinical semantic rules and proposed analysis methods are not approved merely because their synthetic tests pass.

## Remaining engineering work

- Implement Supabase invited sign-in, verified-user JWT RPC calls, TOTP/MFA enforcement and session revocation against a real isolated staging project.
- Implement project/campaign and synthetic-case authoring interfaces; this build provides one fixed, isolated ten-case pilot.
- Connect approved rubric/version registration, sample provenance review, private import, freeze and formal lifecycle screens to the historical schema with the stricter final-submission contract.
- Obtain actual verification RPC results and database view rows for the v4 exporter; the current cross-language round trip uses fully synthetic fixture rows.
- Run actual PostgreSQL and Supabase RLS/API tests, including direct PostgREST table/view/RPC access. PGlite is not evidence of this boundary.
- Complete screen-reader/manual keyboard testing, mobile form usability review, sustained load/latency measurements, backup/restore and operational logging/retention checks.

The optional Module B remains a separate proposed UI entry point and supplied schema/test surface; it has no active application review workflow. Adjudication forms currently retain unsent edits only in the current view and disclose that limitation.
