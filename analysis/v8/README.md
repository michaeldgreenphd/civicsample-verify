# Proposed v8 analysis: synthetic testing only

This is an adapted engineering implementation of the supplied v8 analysis. It does not approve
an allocation, overlap alternative, rubric or estimator. Real-design bundles are refused,
including when `--allow-synthetic` is supplied. No app route imports this module.

Run the tests with the project's analysis dependencies:

```sh
MU8_ALLOW_NO_DB_BUNDLE=1 python -m pytest -q analysis/v8
```

The explicit environment setting permits a **reported skip**, not a passed database integration
check. A v7 database bundle test also skips when that fixture is not supplied.

To exercise proposed calculations on fictional records outside the repository:

```sh
python analysis/v8/fixtures/make_synthetic_v8_bundle.py --out /tmp/synthetic-v8-bundle
python analysis/v8/performance_analysis_v8.py --bundle /tmp/synthetic-v8-bundle --out /tmp/synthetic-v8-results --allow-synthetic
```

Use new output directories for each run. Outputs are synthetic engineering test results and
must not be reported as study results. The two clinical families are kept separate; subgroup
keep/remove counts are separate as well. The fixture is not either private sample alternative.

See [the intake review](../../docs/V8_INTEGRATION_REVIEW.md) for reproduced input-validation
problems, adaptations, remaining export-verification work and pending scientific decisions.

The application-written synthetic database round trip is exercised by
`tests/mu8-roundtrip.test.ts` (see `docs/V8_SYNTHETIC_ROUNDTRIP.md`). It tests
both overlap alternatives without choosing either for the study. Real-design
analysis remains disabled pending the documented scientific and integrity gates.

The loader also checks cross-file judgment/reference consistency, revision
endpoints, adjudication basis and manifest counts. See
[export integrity](../../docs/V8_EXPORT_INTEGRITY.md) for the enforced relationships
and the remaining limits of the four-file format. Checksums and internal
consistency do not authenticate a bundle against a trusted database snapshot.
