# Security model

## Trust boundary

The repository is public; study inputs and operational outputs are private. Source handoffs remain outside the checkout. Only inspected schema, generalized logic and synthetic test artifacts belong here. CI and the pre-commit hook scan for real identifiers, sensitive filenames and secrets. Scanning is defense in depth, not authorization to publish study material.

## Local pilot identities

Four synthetic accounts are available: `investigator`, `reviewer-a`, `reviewer-b`, and `adjudicator`. `npm run setup -- --individual-credentials` generates separate random role passwords in ignored `.env.local` and a private access sheet at `.local/pilot-access.txt`. Setup preserves existing settings and records. Once any role password is configured, missing role credentials fail closed; the legacy shared-password fallback applies only to older pilots without any role passwords. Never commit or publish the access sheet.

Use separate browser profiles on the same computer. Sessions use random opaque tokens and HttpOnly, SameSite=Strict cookies. Sessions expire, are invalidated at logout, and disappear on process restart. The server accepts only loopback Host values, validates Origin for mutations, and rate-limits login attempts. Local role accounts are not verified clinician identities or MFA. Do not use a reverse proxy or public tunnel.

The invitation/JWT helpers in `src/lib/auth.ts` are synthetic test scaffolding. They simulate assurance claims and test session revocation; they do not enroll or verify TOTP. They are not an exposed clinician invitation service and must not become the production identity provider. Production authentication remains an explicit Supabase integration task.

## Authorization and blinding

All API operations require an actor and use explicit allowlisted response shapes. Database policies and functions independently enforce role boundaries. Unassigned and nonexistent cases have the same public failure. Reviewer sessions cannot access administrative exports, audit events, provenance or classifier predictions. Adjudicators never receive predictions. Error responses contain fixed public messages; logs contain no input payloads, judgments, SQL text or evidence. Responses disable caching.

During independent review the investigator sees aggregate completion only. Adjudication requires both independent final submissions and explicit investigator authorization. Final submissions cannot be overwritten. Trials disclose their context only after locked descriptor review. That pre-context Step 1 cannot subsequently be amended, including through an old pending authorization. A legacy submitted Step 1 amendment blocks reference use without altering the original records. Campaign locking prevents subsequent changes.

## Design v5 boundaries

Design v5 keeps its own tables (`tlv5_*`), policies and `rpc_tlv5_*` functions (migrations 0011 and 0012, supplied unchanged). A reviewer reads only the packets of assigned trials and their own submissions; labels, design rows, the freeze, the other reviewer's answers, adjudications and exports are investigator-only or adjudicator-only rows. The adjudicator reads a case only after both independent reviewers have submitted; formal items additionally require close and snapshot. Classifier labels and design fields remain hidden. The investigator reads formal answers only after the close; completion counts come from `rpc_tlv5_completion_summary`. Submissions are audited as identifiers and a hash. Packets are refused when they carry any key or value outside the reviewer-visible allow-list, including a registry address; the trial identifier appears once, as text.

Additive migration 0013 tightens the supplied v5 schema: only the independent ADJUDICATOR may adjudicate in every mode, both independent submissions are required, and ordinary resubmissions are refused. Existing submission history is preserved; an authorized v5 amendment procedure is not implemented. Authenticated database callers cannot use private answer helpers to bypass reviewer isolation. The two synthetic staging reviewer accounts are FORMAL-scope test identities, not clinicians; they are provisioned by an explicit investigator action and never by a silent upgrade. The bulk private-transfer dry-run script is blocked before reading files pending the revised protocol. A separate optional private worked-answer file hook serves only assigned training cases after the reviewer submits; it is unconfigured and untested with real material, and requires hash verification and protocol reconciliation before use.

## Frozen-data upgrade boundary

`applyTrialPacketUpgrades` runs `migrations/preflight_frozen_trial_compatibility.sql` before pending migrations 0008/0009 in the same READ COMMITTED transaction. It also checks already-upgraded databases on every startup. An existing frozen trial must retain its compatible two-step design, trial-context packet, and required prediction levels. Refusal rolls back without rewriting frozen cases or judgments. Historical migrations 0008/0009 retain their original bytes. Protected locked formal references require explicit investigator migration review; they cannot be repaired by deleting the database.

## Deployment gates

Formal activation and real-data import are unavailable in this build. Supabase JWT/RLS/MFA tests, PostgreSQL deployment tests, infrastructure access review, retention/region selection, backup/restore and scientific approval must be completed before any actual clinical review. Never set or send a service-role key to browser code. A production deployment requires replacing local authentication, enforcing TLS, using a production CSP and testing role isolation in a separate staging project.
