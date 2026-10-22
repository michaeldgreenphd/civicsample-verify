# Supplied database regression suites

**SYNTHETIC ENGINEERING ONLY.** These checks exercise fictional accounts and cases in PGlite. They neither activate a study nor establish production authorization or security.

## Observed results

Executed on 2026-10-21 with Node.js 26.8.1 and `@electric-sql/pglite` 0.3.16. The database reported PostgreSQL 17.5 compiled to WebAssembly.

| Supplied suite | Schema applied                  | Observed passing steps | Failures |
| -------------- | ------------------------------- | ---------------------: | -------: |
| v2             | Base schema                     |              164 / 164 |        0 |
| v3             | Base + migration 0002           |              262 / 262 |        0 |
| v3 regression  | Base + migrations 0002 and 0003 |              262 / 262 |        0 |
| v4             | Base + migrations 0002 and 0003 |              356 / 356 |        0 |

The v5 (supplied 0004) and v5.1 (supplied 0005) suites were added on 2026-10-22 and executed with the same Node.js and PGlite versions. The supplied migration files keep their original bytes; only their numbers change, because this repository already holds additive migrations 0004 to 0010.

| Supplied file                                     | Repository file                                   | SHA-256                                                            |
| ------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| `migrations/0004_v5_trial_label_verification.sql` | `migrations/0011_v5_trial_label_verification.sql` | `6f7adf25cecc1b4c5676f252072838abca8e16609fa023382a58fbad823fde2b` |
| `migrations/0005_v5_training_examples.sql`        | `migrations/0012_v5_training_examples.sql`        | `f11871a3f91eb047ac04b8ee38e5e656d36e6a8992a52940e03bae097fad184b` |

| Supplied suite | Schema applied                                                | Observed passing steps | Failures | Documented expected difference |
| -------------- | ------------------------------------------------------------- | ---------------------: | -------: | ------------------------------ |
| v3 regression  | Base + 0002, 0003, 0011, 0012                                 |              262 / 262 |        0 |                                |
| v4 regression  | Base + 0002, 0003, 0011, 0012                                 |              355 / 356 |        1 | `V4-SCHEMA-01`                 |
| v5             | Base + 0002, 0003, 0011                                       |              457 / 457 |        0 |                                |
| v5.1           | Base + 0002, 0003, 0011, 0012                                 |              534 / 534 |        0 |                                |
| v5.1 (app)     | Base + 0002, 0003, this repository's 0004 to 0010, 0011, 0012 |              533 / 534 |        1 | `V5-SCHEMA-01`                 |

The two failing steps read the `app_schema_version` list and expect only the versions of their own lineage. `V4-SCHEMA-01` expects `1.0.0,3.0.0,4.0.0` and sees `5.0.0` and `5.1.0` as well; the supplied v5 test reports record this as the single expected difference. `V5-SCHEMA-01` expects `1.0.0,3.0.0,4.0.0,5.0.0,5.1.0` and, on the application lineage, also sees this repository's `4.0.1` to `4.0.7` versions. Neither step tests behaviour. The wrapper allows exactly these step IDs to fail in exactly these runs and fails on any other step.

The unchanged v3 and v4 suites are not run on the application lineage (0004 to 0010): additive migration 0010 refuses investigator adjudications, which those suites' pilot paths record by design in the supplied schema. The v5 pilot path adjudicates in its own `tlv5_` tables and is unaffected, which is why the v5.1 suite can run on the full lineage.

The separate audit probe reproduced its expected historical distinction: both synthetic trial Step 1 audit rows contained the decision under migration 0002 alone; neither contained the decision after migration 0003. This verifies the demonstrated audit-field correction, not every possible information channel.

These are executed results, not copied historical reports. First, the original runners were executed unmodified in an isolated temporary directory containing only the selected schema, migrations, authentication shim and test code. The supplied v4 shell runner executed the v3 regression, v4 suite and audit probe. The standalone original v2 and v3 runners were also executed. Existing result files were not copied from the source archive. The source archive was not changed.

The sanitized repository runner was then executed and reproduced every count above and the audit probe result. Raw generated result and SQL-log files are kept out of this repository.

## Reproduce from this repository

```sh
npm ci
node scripts/test-handoff.mjs
```

The wrapper copies the committed schema, migrations, shim and test runners into a fresh operating-system temporary directory and uses the installed PGlite dependency. It executes the four original runs plus the probe, then the five v5 runs listed above, checks the exact expected step count and that no step outside the documented allow-list fails, prints one summary line per run, and removes the temporary files (the v5 runners' `view_columns_v5*.json` files are written next to their result files in that temporary directory, never in the repository). It fails if any supplied assertion fails or a suite does not complete. This explicit result inspection is necessary because the original harness scripts can exit successfully even when their JSON summaries contain failed assertions.

`tests/handoff/v2.mjs`, `v3.mjs`, `v4.mjs`, `v5.mjs` and `v5_1.mjs` preserve the inspected supplied test logic. Source-context introductory comments were replaced with a synthetic notice; formatting may differ. The audit probe retains its logic, with a neutral output filename. No preexisting result artifacts, private identities, actual study records, archive manifest, or research extracts are required for reproduction.

## Schema provenance

Only schema-file checksums are recorded here. The committed files match the selected source schema bytes:

| File                                                | SHA-256                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `schema.sql`                                        | `ed52f666e125e86e951b589d2b432e3b411a6c018751b74b9181fa3c3b72fda1` |
| `migrations/0002_v3_review_design.sql`              | `022ec5415775524ad3b4f6a4190fef6d5a85ccc140be98ae3c654b148b90821e` |
| `migrations/0003_v4_record_categories_module_b.sql` | `66822b00bb8ac079364e02bd8adf19d8f9812d1541fee1325cdcf0c520d35f67` |
| `migrations/0011_v5_trial_label_verification.sql`   | `6f7adf25cecc1b4c5676f252072838abca8e16609fa023382a58fbad823fde2b` |
| `migrations/0012_v5_training_examples.sql`          | `f11871a3f91eb047ac04b8ee38e5e656d36e6a8992a52940e03bae097fad184b` |

Verify with:

```sh
shasum -a 256 schema.sql migrations/0002_v3_review_design.sql migrations/0003_v4_record_categories_module_b.sql migrations/0011_v5_trial_label_verification.sql migrations/0012_v5_training_examples.sql
```

## Interpretation and limits

A passing historical step means its encoded expectation was reproduced. Some historical steps deliberately reproduce known helper-access weaknesses; they are not affirmative evidence of a safe production configuration. Later migrations and the application's additive schema require their own current regression tests. These supplied suites do not exercise the application's own migrations or web/API code; the v5.1 run on the application lineage shows only that the supplied v5 behaviour is unchanged by migrations 0004 to 0010.

The native PostgreSQL runner (`npm run test:handoff:postgres`) executes the same nine runs through the `pg` driver, giving each preserved suite as many owned disposable databases as it opens (the v5 suites open three), and records the allowed step IDs and any failure outside them in its sanitized report. It was not executed locally on 2026-10-22 (no native PostgreSQL service; reported BLOCKED).

PGlite uses a synthetic authentication shim and local role switching. It has no real Supabase authentication, PostgREST, network boundary or deployed JWT verification. Live PostgreSQL and Supabase migration/RLS/JWT/MFA checks remain **BLOCKED / NOT EXECUTED**, as do production invitation, deployment, backup/restore and operational access reviews. No clinical accuracy or agreement result is computed by these database tests.
