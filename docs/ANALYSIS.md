# Synthetic export and analysis boundary

**SYNTHETIC ENGINEERING ONLY. The analysis plan is not approved. No clinical review results are reported by this application.**

The seeded ten-case `SYN-` pilot and any additional investigator-authored synthetic pilot cases exercise the workflow and database boundaries. It is excluded from every accuracy, agreement, sensitivity, specificity, predictive-value and confidence-interval computation. Closing or locking this pilot does not approve the protocol, rubric, sampling plan, classifier version or analysis plan.

## Pilot JSON archive

The investigator export route obtains locked data through the server service and calls `buildPilotExport` in `src/lib/export.ts`. The service verifies the immutable judgment snapshot before returning data. The exporter itself requires a locked synthetic campaign and synthetic case IDs.

The archive separates the case/evidence hashes, independent submitted judgments, adjudicated reference, configuration and provenance. Independent judgments retain every revision with its version, reviewer slot and timestamp; adjudication never replaces those records. First submission and later revisions can therefore be reconstructed without interpreting the adjudicated answer as a reviewer response. Missing optional layers remain absent; explicit `INSUFFICIENT_INFORMATION` remains a recorded decision.

Each embedded file includes its exact UTF-8 JSON text, SHA-256 and row count. Object keys use code-point sorting; records sort by case, level, timestamp and record ID; lines end in LF. Repeated exports of unchanged data are byte-identical. Export-access events remain in the database audit log but are excluded from the locked archive; requesting another copy cannot change the archived provenance. The manifest lists those hashes, the sorted LF-joined case-list hash, the campaign and the synthetic notice. `manifest_sha256` hashes the canonical manifest text. Hashes detect content changes; they are not signatures and do not independently authenticate the database.

`clinical_metrics`, `frozen_prediction_set` and `sampling_weights` are explicitly null. `analysis_eligible` is false. Pending approvals remain pending. The exporter does not fabricate a prediction freeze, probability, denominator, or classifier choice. This `pilot-json-1.0` archive is intentionally incompatible with the formal CSV analysis contract.

## Separate adversarial analysis harness

`analysis/` ports the inspected reusable Python statistics and v4 bundle validator. Only the selected generalized code and a fictional fixture generator were retained. Private study datasets, source package manifests, investigator identities and study-specific counts were not copied. This is an engineering implementation of a proposed analysis, not protocol approval or independent statistical validation.

The harness uses `HO4-TESTFX-` identifiers, fictional descriptors and trial identifiers, invented sampling strata and synthetic freeze metadata. It cannot read a pilot archive. The public v4 validator and result entry point refuse non-synthetic manifests or non-fixture case identifiers even when the synthetic test override is supplied. The legacy v3 result entry point is disabled; v3 functions remain as shared statistical helpers.

The synthetic CSV bundle has three separate tables: independent initial/effective judgments, adjudicated reference, and frozen Tier 0/Tier 1 predictions. The manifest verifies file hashes and row counts, the frozen prediction hash, sample identity, version, chronology, blinding and record categories. Every judgment and reference row must carry the manifest export ID; judgments must also match its review module. Predictions must belong to one nonblank prediction-set ID. Reviewer uncertainty and adjudicator exposure require explicit booleans: missing provenance is rejected, never converted to a reassuring false value. Concordant statuses and adjudication bases must agree with the effective independent judgments and the reference disposition. Shared case metadata is compared before merging; each frame unit maps to one case and remains consistent across its determination levels. Case-level strata, inclusion probabilities, weights, stratum sizes and other design attributes must agree between descriptor and trial determinations. Numeric design consistency uses exact decimal comparison, accepting equivalent text encodings without rounding away a discrepancy. Stage C trial status must be blank, INCLUDE, EXCLUDE or UNRESOLVED before the defined fallback is applied; an unsupported value is rejected. Non-rule adjudications require a nonblank identity and a role consistent with their blinding provenance. Provenance hash fields must be 64-character lowercase SHA-256 values. The standalone bundle validator cannot authenticate external ontology/rubric artifacts that are not supplied in the bundle. The database adapter additionally checks those hashes against the registered versions attached to the frozen cases; registration consistency still does not substitute for inspecting and approving the original artifacts. Case versions must be positive integers, consistent across each case's judgment rows, and are preserved in the merged data. The v4 prediction and adjudication tables do not contain case-version fields, so cross-file verification against a frozen version is not available in this format. Paths must be basenames within the bundle; symlinks are refused. Reviewer agreement is calculated from independent judgments. Revision summaries use the exported amendment counts, including amendments that retain the decision. Four-category descriptor exact-match is omitted at trial level, where the classifier performance calculation uses the trial-stage binary prediction. Both classifier tiers use the same case-level reference population, separately for descriptor and trial determinations.

The harness preserves the proposed R0/R1/R2 rules: R0 excludes and counts nondirectional decisions; R1 and R2 map explicit nondirectional decisions to INCLUDE and EXCLUDE respectively. An unresolved or absent reference remains missing under every rule. It never becomes a negative or an explicit indeterminate decision. Zero-denominator statistics serialize as null, with denominator information retained. Wilson, kappa, bootstrap and paired methods retain the source implementation. Bootstrap outputs include their seed and numerical-library version.

A deliberate correction suppresses weighted intervals when variance cannot be identified from a non-census singleton stratum. Point estimates may remain available, but `ci_estimable` is false and the missing interval has an explicit reason. Census singleton strata remain valid. Malformed or inconsistent variance-stratum sizes and fractional revision counts are rejected. These safeguards are engineering changes to the inspected reference implementation and need substantive review before any future formal analysis.

## Reproduce the tests

Use Python 3.13 and the pinned dependencies:

```sh
python3 -m venv .venv
.venv/bin/pip install -r analysis/requirements.txt
.venv/bin/python -m analysis.fixtures.make_synthetic_v4_bundle
.venv/bin/python -m pytest -q analysis
VERIFY_ANALYSIS_PYTHON="$PWD/.venv/bin/python" npm test
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

This is a heuristic gate, not proof that arbitrary prose is safe to publish. Review the staged diff and filenames manually. No production freeze, production identity provider, real reviewer participation, clinical validity assessment or approved analysis run is established by these tests. The pilot archive and analysis harness remain separate. Synthetic database-view-to-CSV-to-Python integration is implemented; its checks are engineering evidence, not authorization to export or analyze real study records.

## Formal-format synthetic CSV writer

`src/lib/formal-export.ts` supplies `buildV4SyntheticBundle` for the separate adversarial harness. It produces the exact v4 three-table CSV format and manifest, not the pilot JSON format. It requires both supplied database integrity-verification flags to be true, a locked synthetic Module A manifest, matching case-level populations, and `HO4-TESTFX-` records. Pilot, development, calibration, and real held-out identifiers are refused. Synthetic approved-extension records require amendment provenance consistent with the manifest; this does not approve a real sample extension. Every required manifest field is supplied explicitly; no scientific choice is filled in by the writer.

`renderV4SyntheticPredictions` is the same renderer intended for computing the prediction-file hash at an engineering freeze. Export compares its bytes with the supplied frozen hash and checks the frozen case-list hash. Numeric database values must be supplied as text; this avoids JavaScript rounding. Timestamps must already be valid ISO UTC text ending in `Z`. NULL cells become empty CSV fields, while explicit decision codes remain text. Columns follow the v4 specification and rows sort by case, determination level and reviewer slot. CSV quoting preserves commas, quotes and embedded newlines.

`tests/formal-export.test.ts` verifies byte equality with the inspected Python-generated synthetic fixture, metadata/lock/integrity failures, case mismatch, freeze changes, and missing-versus-explicit decisions. Its cross-language check writes a new bundle using the TypeScript writer, loads those files through the Python v4 validator and runs paired synthetic analysis with identical denominators for both tiers. Enable that check with:

```sh
VERIFY_ANALYSIS_PYTHON=.venv/bin/python node --import tsx --test tests/formal-export.test.ts
```

Without `VERIFY_ANALYSIS_PYTHON`, the cross-language checks explicitly skip while the TypeScript checks execute. The pure writer accepts an explicit input object; testing it alone is distinct from testing the database adapter.

## Synthetic database-to-analysis adapter

`loadV4SyntheticExportInputFromDb` and `exportV4SyntheticBundleFromDb` read `v_independent_judgments_v4`, `v_adjudicated_reference_v4`, and `v_frozen_predictions_v4`, together with frozen manifest and reference-lock metadata. Integrity results come from `rpc_verify_frozen_predictions_v4()` and `rpc_verify_judgment_snapshot_v4()`. A failed verification prevents export. `tests/formal-export.test.ts` exercises the synthetic database-to-writer-to-Python path as well as the standalone fixture writer; consult the readiness report for observed command results.

The adapter requires an explicit `appGitSha`: a nonzero, 40-character lowercase Git commit SHA supplied by the server/build environment. It does not substitute a zero hash or a synthetic version label. The caller is responsible for identifying the actual running build; syntax validation alone cannot attest the executable.

The opening timestamp comes from the recorded `FORMAL_UNLOCKED` event, never from assignment creation or a manufactured freeze timestamp. In the preserved v4 database workflow, unlocking authorizes enrolment and precedes the freeze RPC. The analysis accepts that event order but requires every independent judgment to follow both unlocking and freezing. Closing must follow both events; reference assessments must occur between closing and reference lock. These checks preserve review readiness without rewriting the actual lifecycle history. Unless explicitly supplied, the export identity is deterministically derived from the freeze and reference-lock IDs: repeated exports of that state retain their identity, while different frozen/locked evaluations receive distinct identities.

Ontology and rubric identifiers and SHA-256 values are resolved from the registered version set attached to the frozen cases. The registration must predate the freeze, cover the frozen case list, and agree across cases. Its hashes must match the freeze manifest. Missing, mixed, inconsistent, or later registrations fail closed. Optional caller version assertions must match database provenance; they cannot override it. An unrelated later ontology registration must not change an existing export.

`queryV4PreFreezePredictionsFromDb` and `computeV4PredictionFileSha256FromDb` use the writer's serialization before freeze so the recorded file hash can be checked against the later export. Database numeric fields remain text, and timestamps are projected to UTC. Full semantic checks, including mapping policy, revision chronology, and adjudication consistency, also run at the database and Python boundaries; the pure CSV writer does not independently reconstruct those judgments.

These functions remain restricted to synthetic bundles. They are not connected to a formal clinical export screen or a deployed Supabase identity provider. Real study lifecycle integration, scientific approval, and deployment verification remain outstanding.

## Design v5 bundle (format 5.0)

`src/lib/tlv5-export.ts` renders the three investigator-only export views (`v_tlv5_independent_judgments`, `v_tlv5_adjudicated_reference`, `v_tlv5_frozen_labels`) as CSV with LF line ends, empty fields for SQL NULL, `true`/`false` booleans and ISO 8601 UTC timestamps, plus the manifest with every key of `docs/design_v5/EXPORT_TO_PERFORMANCE_SPEC_v5.md`. The manifest `export_id` is derived from the reference lock so that repeated exports of an unchanged locked state are byte-identical; the database registration records the row counts, file hashes and manifest hash. `analysis/performance_analysis_v5.py` (supplied, adapted only in its imports and a pandas 3 NaN check) refuses a pilot bundle without `--allow-pilot` and a TESTFX synthetic bundle without `--allow-synthetic`; `tests/tlv5.test.ts` runs both round trips when `VERIFY_ANALYSIS_PYTHON` is set. Training and calibration rows never reach an export view.
