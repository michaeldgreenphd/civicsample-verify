# Review design v8: engineering intake

Status: synthetic analysis foundation only. No scientific gate, sample, rubric, estimator or
probability file is approved by this change. The live v7 practice application is unchanged.

## Verified inputs and bounded integration

The public archive digest matched the transferred checksum and all 58 files listed in its
internal SHA256SUMS matched. The archive has 59 entries including the checksum file itself.
The private archive digest matched, but private records were not imported or copied into this
repository. The source package remains outside the repository.

The supplied Python suite ran before adaptation: **30 passed, 2 skipped**. Both skips require
application/database-written bundles (one v7, one v8). These are not passed integration gates.

Only generalized Python analysis, synthetic fixture generation, tests, and the code vocabulary
were adapted into `analysis/v8`. The proposed display policies were not copied into the app.
Personnel names in a supplied source comment were removed. Fictional identifiers use
`SYN-TRIAL-` rather than registry-format identifiers; the existing fixture guard is unchanged.
No sample tables, private hashes, registry text, operational responses or original archives
were committed. The analysis vocabulary is a test input, not an approved reviewer definition.

## Reproduced findings and fixes

| Severity                      | Supplied behavior reproduced with synthetic input                                                                                                                                                                   | Engineering fix                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blocker for real analysis     | Changing the reference file's family/category, and updating its manifest file checksum, moved one AREA unit into ROW: the analysis accepted 55 area and 41 row units despite the frozen unit table retaining 56/40. | Compare reference metadata with frozen units and derive families from the unit table; check the category against the frozen mapping code.                              |
| Blocker for real analysis     | Replacing the manifest status with FORMAL let a SYN-8 fixture run without explicit synthetic permission and marked its results non-synthetic.                                                                       | Recognize the synthetic design independently of status; require explicit synthetic permission. This integration refuses real-design bundles even with that permission. |
| Blocker for weighted analysis | An inclusion probability of 2 was accepted and produced weight 0.5. Duplicate probability rows silently replaced earlier values.                                                                                    | Require exactly one probability per unit, finite and in (0, 1].                                                                                                        |

Additional tests reject duplicate unit rows, unexpected judgment units, mixed record modes,
pilot record categories, and repeated trials under ONE_PER_TRIAL, even when file hashes match.
These are integrity checks; estimator formulas and scientific choices were not changed.

## Still required before real analysis or activation

- Additive database integration after 0032 for the three new area codes and pending gate
  requirements, with old-version compatibility and native PostgreSQL checks.
- Decide allocation, overlap, new-area definitions, text and rubric through investigator
  approvals. G-EST-01 remains a freeze prerequisite; no estimator is approved here.
- Bind and serve the approved scientific rubric. The existing operational practice guide is
  not evidence that rubric 7.1 or proposed rubric v8 is served and hash-bound.
- Write a v8 synthetic bundle through the real application/database export path. Validate
  reference-lock and snapshot provenance, complete all cross-file checks, and verify
  probability-file provenance before lifting the synthetic-only restriction.
- Carry forward the Pain decision explicitly for the selected new design; do not treat an
  earlier approval as approval of changed units or hashes.
- Validate private alternatives separately on disposable databases. A freeze refusal at a
  gate does not prove later hash checks ran; verify hashes independently.
- Preserve practice records. Use a separate disposable database for design-transition tests;
  no existing cloud project was changed and no additional project was provisioned.

The proposed allocation is 56 AREA, 40 ROW and 4 subgroup units. Area and row results stay
separate. Both overlap alternatives are proposals; no alternative is selected by tests.
Analysis outputs are labelled synthetic engineering results. Tests do not validate the study's
medical definitions, sampling adequacy or estimator choice.

## Executed checks (2026-10-24)

- Supplied suite outside the repository: 30 passed, 2 database-fixture skips.
- `MU7_ALLOW_NO_DB_BUNDLE=1 MU8_ALLOW_NO_DB_BUNDLE=1 python -m pytest -q analysis`
  with the local analysis virtual environment: 449 passed, 3 database-fixture skips.
- `VERIFY_ANALYSIS_PYTHON=<local-analysis-venv-python> npm run check`: PASS;
  241 Node tests passed, 0 failed, 31 skipped, 1 existing todo. Typecheck and lint passed;
  fixture and v4/v5/v7 leakage scans reported zero violations.
- `npm run build`: PASS; production trace check passed with 34 SQL inputs and no local
  runtime files. No SQL file changed in this increment.
- Prettier checks of changed supported files and `git diff --check`: PASS.
- Native PostgreSQL and live Supabase: NOT TESTED locally; no remote request or mutation.
- Browser E2E was not rerun for this analysis-only increment; no served UI or route changed.
- The v8 database-written export round trip remains NOT TESTED. An explicit skip is retained
  in CI until the database increment supplies it. Synthetic unit tests do not substitute for it.
