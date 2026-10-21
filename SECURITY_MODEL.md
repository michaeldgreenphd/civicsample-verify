# Security model

## Trust boundary

The repository is public; study inputs and operational outputs are private. Source handoffs remain outside the checkout. Only inspected schema, generalized logic and synthetic test artifacts belong here. CI and the pre-commit hook scan for real identifiers, sensitive filenames and secrets. Scanning is defense in depth, not authorization to publish study material.

## Local pilot identities

Four synthetic accounts are available: investigator, reviewer-a, reviewer-b and adjudicator. A random password is generated into ignored .env.local by npm run setup. Sessions use random opaque tokens and HttpOnly, SameSite=Strict cookies. Sessions expire, are invalidated at logout and disappear on process restart. The server accepts only loopback Host values, validates Origin for mutations and rate-limits login attempts. This is a local development authentication mechanism, not a substitute for invited clinician identity or MFA. Do not use a reverse proxy or public tunnel.

## Authorization and blinding

All API operations require an actor and use explicit allowlisted response shapes. Database policies and functions independently enforce role boundaries. Unassigned and nonexistent cases have the same public failure. Reviewer sessions cannot access administrative exports, audit events, provenance or classifier predictions. Adjudicators never receive predictions. Error responses contain fixed public messages; logs contain no input payloads, judgments, SQL text or evidence. Responses disable caching.

During independent review the investigator sees aggregate completion only. Adjudication requires both independent final submissions and explicit investigator authorization. Final submissions cannot be overwritten. Trials disclose their context only after locked descriptor review. That pre-context Step 1 cannot subsequently be amended, including through an old pending authorization. A legacy submitted Step 1 amendment blocks reference use without altering the original records. Campaign locking prevents subsequent changes.

## Deployment gates

Formal activation and real-data import are unavailable in this build. Supabase JWT/RLS/MFA tests, PostgreSQL deployment tests, infrastructure access review, retention/region selection, backup/restore and scientific approval must be completed before any actual clinical review. Never set or send a service-role key to browser code. A production deployment requires replacing local authentication, enforcing TLS, using a production CSP and testing role isolation in a separate staging project.
