# Architecture

CivicSample Verify is a Next.js App Router / TypeScript application. The app serves a local, investigator-operated synthetic pilot. It has no AI integration and sends no evidence to an external service.

The HTTP boundary authenticates a session, checks the request origin, validates input, and calls a server-only data layer. The database enforces role and record access again. Client code receives explicit evidence and workflow DTOs, never database rows or investigator-only design objects.

The supplied v4 package recommends Python/FastAPI or Streamlit. The investigator's current request prefers Next.js. We retain the PostgreSQL schema/migration lineage and Python analysis while using Next.js for the web interface. The handoff schemas remain unmodified; an additive migration implements the stricter synthetic pilot lifecycle requested by the investigator. This extension is not proof of production/formal workflow compatibility.

Local storage uses PGlite (PostgreSQL in WebAssembly) persisted in ignored .local storage. The original Supabase auth shim supplies authenticated identities only inside this local environment. PGlite is not a deployed PostgreSQL or Supabase security test. Production must use an invited Supabase identity, verified user JWT, investigator MFA, and the supplied database RPCs without a service-role key in the web process. Those integration gates are explicitly tracked in READINESS_REPORT.md.

Judgments, adjudication and exports are distinct. Reviewer DTOs contain only their own assignment, draft and submitted work. Trial evidence is disclosed only after the reviewer's descriptor determination is locked. An investigator closes review, authorizes adjudication, and locks the completed reference explicitly. No application endpoint can activate formal research.

Analysis lives separately under analysis/. Pilot export is an engineering audit artifact, not a performance bundle. Formal-format compatibility is exercised only with explicit synthetic test records. Module B is reserved as a separately approved study module.

The deployment decision, hosting region and retention policy remain investigator decisions. This local prototype is intentionally not a public hosting configuration.
