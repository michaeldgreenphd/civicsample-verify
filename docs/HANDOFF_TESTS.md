# Supplied database regression suites

**SYNTHETIC ENGINEERING ONLY.** These checks exercise fictional accounts and cases in PGlite. They neither activate a study nor establish production authorization or security.

## Observed results

Executed on 2026-10-21 with Node.js 26.8.1 and `@electric-sql/pglite` 0.3.16. The database reported PostgreSQL 17.5 compiled to WebAssembly.

| Supplied suite | Schema applied | Observed passing steps | Failures |
|---|---|---:|---:|
| v2 | Base schema | 164 / 164 | 0 |
| v3 | Base + migration 0002 | 262 / 262 | 0 |
| v3 regression | Base + migrations 0002 and 0003 | 262 / 262 | 0 |
| v4 | Base + migrations 0002 and 0003 | 356 / 356 | 0 |

The separate audit probe reproduced its expected historical distinction: both synthetic trial Step 1 audit rows contained the decision under migration 0002 alone; neither contained the decision after migration 0003. This verifies the demonstrated audit-field correction, not every possible information channel.

These are executed results, not copied historical reports. First, the original runners were executed unmodified in an isolated temporary directory containing only the selected schema, migrations, authentication shim and test code. The supplied v4 shell runner executed the v3 regression, v4 suite and audit probe. The standalone original v2 and v3 runners were also executed. Existing result files were not copied from the source archive. The source archive was not changed.

The sanitized repository runner was then executed and reproduced every count above and the audit probe result. Raw generated result and SQL-log files are kept out of this repository.

## Reproduce from this repository

```sh
npm ci
node scripts/test-handoff.mjs
```

The wrapper copies the committed schema, migrations, shim and test runners into a fresh operating-system temporary directory and uses the installed PGlite dependency. It executes all four suites plus the probe, checks both the exact expected step count and failure count, prints summaries, and removes the temporary files. It fails if any supplied assertion fails or a suite does not complete. This explicit result inspection is necessary because the original harness scripts can exit successfully even when their JSON summaries contain failed assertions.

`tests/handoff/v2.mjs`, `v3.mjs` and `v4.mjs` preserve the inspected supplied test logic. Source-context introductory comments were replaced with a synthetic notice; formatting may differ. The audit probe retains its logic, with a neutral output filename. No preexisting result artifacts, private identities, actual study records, archive manifest, or research extracts are required for reproduction.

## Schema provenance

Only schema-file checksums are recorded here. The committed files match the selected source schema bytes:

| File | SHA-256 |
|---|---|
| `schema.sql` | `ed52f666e125e86e951b589d2b432e3b411a6c018751b74b9181fa3c3b72fda1` |
| `migrations/0002_v3_review_design.sql` | `022ec5415775524ad3b4f6a4190fef6d5a85ccc140be98ae3c654b148b90821e` |
| `migrations/0003_v4_record_categories_module_b.sql` | `66822b00bb8ac079364e02bd8adf19d8f9812d1541fee1325cdcf0c520d35f67` |

Verify with:

```sh
shasum -a 256 schema.sql migrations/0002_v3_review_design.sql migrations/0003_v4_record_categories_module_b.sql
```

## Interpretation and limits

A passing historical step means its encoded expectation was reproduced. Some historical steps deliberately reproduce known helper-access weaknesses; they are not affirmative evidence of a safe production configuration. Later migrations and the application's additive schema require their own current regression tests. These supplied suites do not exercise the new application migration or web/API code.

PGlite uses a synthetic authentication shim and local role switching. It has no real Supabase authentication, PostgREST, network boundary or deployed JWT verification. Live PostgreSQL and Supabase migration/RLS/JWT/MFA checks remain **BLOCKED / NOT EXECUTED**, as do production invitation, deployment, backup/restore and operational access reviews. No clinical accuracy or agreement result is computed by these database tests.
