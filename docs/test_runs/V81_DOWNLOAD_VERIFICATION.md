# Download verifier follow-up

Base: `918c198c416c27c712cf367a157979b7e4f241bf` (PR #22). This change updates an offline command and synthetic tests only. No database migration, browser behavior, scientific decision or live record changes.

Executed locally:

- `node --import tsx --test tests/bundle-download-verification.test.ts tests/supabase-pilot-tools.test.ts`: 33 passed, zero failures or skips. Covers valid formats and modes, actual legacy pilot exports, malformed input, changed hashes/bindings, high-precision decimals, symlinks, sanitized CLI output and missing registration-check arguments.
- `node --import tsx --test --test-name-pattern 'v8.1 bound probability' tests/mu8-roundtrip.test.ts`: two passed. Both alternatives write actual database bundles, and verify their formal and pilot downloads against their registered-manifest hashes. The full check below additionally attaches Python to these round trips.
- `VERIFY_ANALYSIS_PYTHON=<existing-analysis-python> npm run check`: passed, 288 tests passed, zero failures, 34 existing skips and one existing todo. Includes typecheck, lint, Python-backed database round trips, fixture scan and v4/v5/v7 leakage scans with zero violations.
- `npm run build`: passed, 37 SQL inputs and no local runtime files in production traces.
- Changed-file Prettier and `git diff --check`: passed.

Browser checks are not repeated for an offline-tool-only change. The base head's production browser suite passed ten scenarios, and its hosted web, analysis and PostgreSQL jobs all passed. No live Supabase request was made. The checker is not a replacement for full snapshot reconstruction or the scientific analysis validator.
