# CivicSample Verify development rules

- Read README.md, SECURITY_MODEL.md, docs/SCIENTIFIC_CONTRACT.md and READINESS_REPORT.md before changing behavior.
- This is a public repository. Commit generalized code and fully synthetic fixtures only. Never copy research archives, investigator-only contracts, real cases/evidence, identities, credentials, reviewer responses or research extracts here.
- Preserve schema.sql and migrations 0002/0003. New database behavior goes in numbered additive migrations, with authorization and integrity tests.
- User instructions override handoff recommendations. Scientific choices require explicit investigator approval; proposed, approved and frozen states are distinct. No production activation, invitations or actual study import during the build phase.
- Enforce access in the database and server, use allowlisted DTOs, and never send classifier labels or other reviewers' work to reviewers. Do not log payloads.
- Final judgments are immutable; amendments must be append-only and explicitly authorized. Adjudications are separate records.
- Pilot, development and calibration records never enter primary performance statistics. Module B remains separate.
- Run npm run check, npm run build and relevant npm run test:e2e checks. Report exact results; unavailable PostgreSQL/Supabase checks are BLOCKED, never PASS.
- Run the sensitive-fixture scanner before commits. One editor per file; preserve unrelated changes. Feature branches only; the investigator merges and deploys.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
