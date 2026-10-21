# Synthetic export and analysis boundary

**SYNTHETIC ENGINEERING ONLY. The analysis plan is not approved. No clinical review results are reported by this application.**

The ten-case `SYN-` pilot exercises the workflow and database boundaries. It is excluded from every accuracy, agreement, sensitivity, specificity, predictive-value and confidence-interval computation. Closing or locking this pilot does not approve the protocol, rubric, sampling plan, classifier version or analysis plan.

## Pilot JSON archive

The investigator export route obtains locked data through the server service and calls `buildPilotExport` in `src/lib/export.ts`. The service verifies the immutable judgment snapshot before returning data. The exporter itself requires a locked synthetic campaign and synthetic case IDs.

The archive separates the case/evidence hashes, independent submitted judgments, adjudicated reference, configuration and provenance. Independent judgments retain every revision with its version, reviewer slot and timestamp; adjudication never replaces those records. First submission and later revisions can therefore be reconstructed without interpreting the adjudicated answer as a reviewer response. Missing optional layers remain absent; explicit `INSUFFICIENT_INFORMATION` remains a recorded decision.

Each embedded file includes its exact UTF-8 JSON text, SHA-256 and row count. Object keys use code-point sorting; records sort by case, level, timestamp and record ID; lines end in LF. Repeated exports of unchanged data are byte-identical. Export-access events remain in the database audit log but are excluded from the locked archive; requesting another copy cannot change the archived provenance. The manifest lists those hashes, the sorted LF-joined case-list hash, the campaign and the synthetic notice. `manifest_sha256` hashes the canonical manifest text. Hashes detect content changes; they are not signatures and do not independently authenticate the database.

`clinical_metrics`, `frozen_prediction_set` and `sampling_weights` are explicitly null. `analysis_eligible` is false. Pending approvals remain pending. The exporter does not fabricate a prediction freeze, probability, denominator, or classifier choice. This `pilot-json-1.0` archive is intentionally incompatible with the formal CSV analysis contract.

## Separate adversarial analysis harness

`analysis/` ports the inspected reusable Python statistics and v4 bundle validator. Only the selected generalized code and a fictional fixture generator were retained. Private study datasets, source package manifests, investigator identities and study-specific counts were not copied. This is an engineering implementation of a proposed analysis, not protocol approval or independent statistical validation.

The harness uses `HO4-TESTFX-` identifiers, fictional descriptors and trial identifiers, invented sampling strata and synthetic freeze metadata. It cannot read a pilot archive. The public v4 validator and result entry point refuse non-synthetic manifests or non-fixture case identifiers even when the synthetic test override is supplied. The legacy v3 result entry point is disabled; v3 functions remain as shared statistical helpers.

The synthetic CSV bundle has three separate tables: independent initial/effective judgments, adjudicated reference, and frozen Tier 0/Tier 1 predictions. The manifest verifies file hashes and row counts, the frozen prediction hash, sample identity, version, chronology, blinding and record categories. Every judgment and reference row must carry the manifest export ID; judgments must also match its review module. Predictions must belong to one nonblank prediction-set ID. Reviewer uncertainty and adjudicator exposure require explicit booleans: missing provenance is rejected, never converted to a reassuring false value. Concordant statuses and adjudication bases must agree with the effective independent judgments and the reference disposition. Shared case metadata is compared before merging; each frame unit maps to one case and remains consistent across its determination levels. Non-rule adjudications require a nonblank identity and a role consistent with their blinding provenance. Provenance hash fields must be 64-character lowercase SHA-256 values. This syntax check does not authenticate external ontology/rubric artifacts that are not supplied in the bundle. Case versions must be positive integers, consistent across each case's judgment rows, and are preserved in the merged data. The v4 prediction and adjudication tables do not contain case-version fields, so cross-file verification against a frozen version is not available in this format. Paths must be basenames within the bundle; symlinks are refused. Reviewer agreement is calculated from independent judgments. Revision summaries use the exported amendment counts, including amendments that retain the decision. Four-category descriptor exact-match is omitted at trial level, where the classifier performance calculation uses the trial-stage binary prediction. Both classifier tiers use the same case-level reference population, separately for descriptor and trial determinations.

The harness preserves the proposed R0/R1/R2 rules: R0 excludes and counts nondirectional decisions; R1 and R2 map explicit nondirectional decisions to INCLUDE and EXCLUDE respectively. An unresolved or absent reference remains missing under every rule. It never becomes a negative or an explicit indeterminate decision. Zero-denominator statistics serialize as null, with denominator information retained. Wilson, kappa, bootstrap and paired methods retain the source implementation. Bootstrap outputs include their seed and numerical-library version.

A deliberate correction suppresses weighted intervals when variance cannot be identified from a non-census singleton stratum. Point estimates may remain available, but `ci_estimable` is false and the missing interval has an explicit reason. Census singleton strata remain valid. Malformed or inconsistent variance-stratum sizes and fractional revision counts are rejected. These safeguards are engineering changes to the inspected reference implementation and need substantive review before any future formal analysis.

## Reproduce the tests

Use Python 3.13 and the pinned dependencies:

```sh
python3 -m venv .venv
.venv/bin/pip install -r analysis/requirements.txt
.venv/bin/python -m analysis.fixtures.make_synthetic_v4_bundle
.venv/bin/python -m pytest -q analysis
npm test
npm run check:fixtures
```

To exercise the proposed format using only the fictional fixture:

```sh
.venv/bin/python -m analysis.performance_analysis_v4 \
  --manifest analysis/fixtures/synthetic_v4_bundle.manifest.json \
  --out /tmp/verify-synthetic-analysis --allow-synthetic
```

All generated results are engineering test output. The trace-template fixture is a rendering test, not manuscript prose. Its synthetic warning is retained. Tests compare hand-counted confusion matrices, preserve paired denominators, distinguish missing versus explicit indeterminate responses, reproduce byte-identical fixtures, separate initial judgments from adjudication, and challenge malformed hashes, record categories, blinding and chronology.

## Leakage guard and limitations

`scripts/check-fixtures.mjs` checks tracked files and prospective source files, including untracked exports. It excludes dependency, build, runtime-database and test-cache directories from recursive discovery; a tracked file in those directories is still checked. It rejects registry IDs, non-fixture held-out IDs, known private source filenames/locations, common credentials, secrets files, unreviewed document/archive/database binaries and unmarked tabular data. Temporary injection tests exercise these refusals without committing sensitive examples. Diagnostics report the rule and path, never the matched secret.

This is a heuristic gate, not proof that arbitrary prose is safe to publish. Review the staged diff and filenames manually. No production freeze, production identity provider, real reviewer participation, clinical validity assessment or approved analysis run is established by these tests. The pilot archive and analysis harness remain separate. Actual SQL view to CSV writer integration is not established by the fixture compatibility test below.

## Formal-format synthetic CSV writer

`src/lib/formal-export.ts` supplies `buildV4SyntheticBundle` for the separate adversarial harness. It produces the exact v4 three-table CSV format and manifest, not the pilot JSON format. It requires both supplied database integrity-verification flags to be true, a locked synthetic Module A manifest, matching case-level populations, and `HO4-TESTFX-` records. Pilot, development, calibration, real held-out identifiers and extensions are refused. Every required manifest field is supplied explicitly; no scientific choice is filled in by the writer.

`renderV4SyntheticPredictions` is the same renderer intended for computing the prediction-file hash at an engineering freeze. Export compares its bytes with the supplied frozen hash and checks the frozen case-list hash. Numeric database values must be supplied as text; this avoids JavaScript rounding. Timestamps must already be valid ISO UTC text ending in `Z`. NULL cells become empty CSV fields, while explicit decision codes remain text. Columns follow the v4 specification and rows sort by case, determination level and reviewer slot. CSV quoting preserves commas, quotes and embedded newlines.

`tests/formal-export.test.ts` verifies byte equality with the inspected Python-generated synthetic fixture, metadata/lock/integrity failures, case mismatch, freeze changes, and missing-versus-explicit decisions. Its cross-language check writes a new bundle using the TypeScript writer, loads those files through the Python v4 validator and runs paired synthetic analysis with identical denominators for both tiers. Enable that check with:

```sh
VERIFY_ANALYSIS_PYTHON=.venv/bin/python node --import tsx --test tests/formal-export.test.ts
```

Without `VERIFY_ANALYSIS_PYTHON` the cross-language test explicitly skips; the three pure TypeScript writer tests still execute. This is fixture-to-writer-to-analysis evidence, **not a database-view-to-writer production integration test**. The integrity booleans in this isolated test are synthetic inputs. A future database adapter must obtain them from the actual verification RPCs, supply the actual locked manifest and views, and preserve freeze-time serialization. Full semantic checks including mapping policy, revision chronology and adjudication consistency remain the responsibility of the database and Python validator; this pure writer does not recompute their values.
