# CivicSample Verify

An investigator-operated synthetic pilot for blinded clinical classification review. Two independent reviewers assess the same fictional evidence, a separate adjudicator resolves their judgments, and the investigator locks and exports the audit record. **This build cannot activate formal clinical review or import real study records.**

## Start locally

Requires Node.js 22 or newer and npm.

```sh
npm ci
npm run setup
npm run dev
```

Open http://127.0.0.1:3000. Setup generates a local pilot password in ignored `.env.local`. Use it with `investigator`, `reviewer-a`, `reviewer-b`, or `adjudicator`. All accounts are fictional and intended for investigator testing. Storage persists in ignored `.local/pglite`; restarting does not erase decisions. Restart the local server after updating this branch so additive database migrations are applied; keep the data directory intact. Migration 0007 refuses an existing locked formal v4 reference, because changing reference selection could reinterpret a frozen result. Preserve that database and its original exports for explicit investigator migration review; do not reset it to bypass the guard. This restriction does not apply to the local synthetic pilot. Use independent browser profiles or sign out to change roles.

1. Review the investigator's campaign and blocked formal gates.
2. Sign in as each reviewer, save drafts, and submit the same ten cases. A trial case requires a locked descriptor determination before trial evidence appears.
3. As investigator, close independent review and explicitly authorize adjudication.
4. As adjudicator, record separate final decisions.
5. As investigator, lock the reference and download the synthetic audit export.

Final answers are locked; the app never suggests or pre-fills clinical judgments. The pilot export is excluded from performance analysis. See [docs/ANALYSIS.md](docs/ANALYSIS.md) for the separate synthetic analysis harness.

## Verification

```sh
npm run check
npm run build
npx playwright install chromium
npm run test:e2e:production
npm run test:handoff
```

Read [READINESS_REPORT.md](READINESS_REPORT.md) for observed results and blocked external-service tests. PGlite success does not establish deployed PostgreSQL/Supabase security. Automated browser tests use a separate ignored database.

## Engineering boundaries

- [ARCHITECTURE.md](ARCHITECTURE.md): web/database/analysis boundaries and the handoff stack decision.
- [SECURITY_MODEL.md](SECURITY_MODEL.md): local authentication, database authorization and blinding.
- [docs/SCIENTIFIC_CONTRACT.md](docs/SCIENTIFIC_CONTRACT.md): sanitized invariants and unresolved scientific decisions.
- [docs/APPROVAL_GATES.md](docs/APPROVAL_GATES.md): formal activation prerequisites.
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): staging and invited-team deployment plan.

This public repository must never contain private research handoffs, real case/evidence packets, formal sample IDs, clinician identity, credentials or reviewer responses. Original supplied migrations are preserved; new behavior uses additive migrations. No scientific approvals are inferred from the functioning interface.

## Current build scope

The local synthetic review/adjudication workflow is implemented and browser-tested. This is not yet the complete production/formal-study platform: invited Supabase authentication/MFA, formal campaign/import/freeze UI, actual database-view-to-analysis export integration, and general project/case management remain outstanding. Formal activation is therefore denied in code, not merely hidden. The readiness report names each incomplete acceptance item.

The proposed analysis harness is separately reproducible; install `analysis/requirements.txt` in a Python environment and set `VERIFY_ANALYSIS_PYTHON` to that environment's Python when running `npm run check` to include the cross-language round trip. Otherwise that one test reports SKIP.

![Synthetic reviewer interface](docs/screenshots/reviewer-desktop.png)
