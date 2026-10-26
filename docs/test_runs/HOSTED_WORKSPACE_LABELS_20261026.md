# Hosted workspace labels and intake status

The hosted sign-in and page header use neutral review-workspace wording; the local synthetic environment retains its explicit fabricated-data warning. The page waits for session context before choosing either label. A recorded v8.1 study design uses Study preparation, shows no synthetic pilot setup controls, and continues to state that clinical review is closed.

A successful intake refreshes the investigator's preparation summary. If that follow-up read fails, the UI preserves the successful import message rather than reporting that the import failed. Authentication, database policies, migrations and scientific gates are unchanged.

## Executed checks

- `VERIFY_ANALYSIS_PYTHON=<existing analysis virtualenv>/bin/python npm run check`: 401 passed, 0 failed, 39 skipped, 1 existing TODO. Typecheck, lint and all fixture/leakage scans passed. Unavailable native PostgreSQL and live-service tests remain skipped, not accepted as passing.
- `npm run build`: passed from a clean isolated checkout; 41 allowed SQL inputs and no local runtime files in production traces.
- `npm run test:e2e:production`: 18 passed. Includes session-loading wording, hosted login/navigation, synthetic practice, preparation-label changes after a mocked successful intake, updated count, retained success after a mocked refresh failure, responsive widths and existing role/authorization scenarios.
- Targeted `prettier --check` on all changed TypeScript and documentation files: passed. Unchanged vendored files were not reformatted.
- `git diff --check`: passed.

The served-browser intake checks use synthetic response fixtures; they do not claim a live database import or clinical release. No new native database behavior is introduced by this change. Live operational reports and study inputs are kept outside the public repository.
