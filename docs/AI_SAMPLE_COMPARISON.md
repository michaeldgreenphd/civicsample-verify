# Offline comparison with completed clinical review

These tools extend the completed mapping experiment; they never rerun it. They make
no provider calls, need no provider key, and have no database or deployment client.
The existing Python test workflow covers them using fictional inputs. The paid
mapping and label-pilot workflows, prompts, ledgers and budgets are unchanged.

The cohort assignment experiment is a separate proposed design. This change does
not implement its runner, draw a sample, select a screening model or authorize spending.

## Existing run inventory

`scripts/ai-mapping-review/completed_runs.py` validates the original mapping ledger
and the completed label pilot against their input pins, reconstructed requests,
responses, usage receipts, recovery archives, rejected attempts and missing-output
closures. It reports counts and cumulative accounting only. The held reservation
is retained, and the mapping cost is counted exactly once. A partially complete or
unreconciled pilot refuses validation. This is recorded-usage accounting at the
existing pinned prices, not a provider invoice or a new spending authorization.

Read the existing private store into a private staging directory **outside every
Git checkout**, pin the exact bytes, and run:

```sh
python3 scripts/ai-mapping-review/completed_runs.py \
  --mapping-ledger /private/staging/mapping-review-ledger.json --mapping-sha256 MAPPING_SHA256 \
  --pilot-input /private/staging/label-pilot.json --pilot-input-sha256 PILOT_INPUT_SHA256 \
  --pilot-ledger /private/staging/label-pilot-ledger.json --pilot-sha256 PILOT_LEDGER_SHA256
```

The placeholders above are not executable pins. Obtain each SHA-256 from the
investigator's private source record; do not substitute a newly created ledger.

## Answer-free comparability capture

`check_live_comparability.py` accepts the original pinned AI input and a separately
captured, answer-free JSON document with this shape:

```json
{
  "format": "civicsample-ai-live-comparability-1.0",
  "captured_at": "2026-01-01T00:00:00Z",
  "app_commit": "<verified deployed source commit, 40 lowercase hex characters>",
  "renderer_revision_verified": true,
  "freeze": {
    "unit_list_sha256": "<live freeze unit-list digest>",
    "import_sha256": "<live immutable intake source_import_sha256>"
  },
  "guide": {"profile_id": "<active guide/protocol>", "sha256": "<guide digest>", "text": "<exact guide>"},
  "units": []
}
```

The empty list illustrates the envelope only; execution requires all 100 units.
Each unit carries the original AI input's allowlisted fields:
`unit_id`, `packet`, `display`, `answer_options`, `reason_codes`, `subtype_required`,
plus `stored_packet_sha256` copied from the corresponding stored task row. That
storage digest must match `units.csv` in the later locked export; it must not be
recomputed using a different JSON serialization.
Capture those fields from the verified deployed renderer and its frozen task
inputs. Do not include clinician answers, identities, completion progress or
adjudication. Do not copy the AI input into the live envelope. The import digest
comes from the immutable intake receipt; it is not a column of the freeze table.

`renderer_revision_verified` is an investigator provenance assertion, not something
this offline script can discover. A local source projection without confirmation
that its revision is deployed must keep this false and is refused. The script also
cannot certify screen text outside the capture, such as supplemental answer-panel
context or navigation copy; record and review such differences independently.

The unit list is recomputed from sorted IDs joined by line feeds. Units are paired
by ID, never array position. Packet hashes use the existing runner's canonical JSON
on both allowlisted packets, not a mixture of PostgreSQL `jsonb::text` and Python
serialization. Packet provenance includes the allowed packet fields; the original
model request continues to strip intervention descriptions as before.

```sh
python3 scripts/ai-mapping-review/check_live_comparability.py \
  --ai-input /private/staging/mapping-review.json --ai-sha256 AI_INPUT_SHA256 \
  --live-snapshot /private/staging/live-comparability.json --live-sha256 LIVE_CAPTURE_SHA256
```

Stdout is one JSON line: freeze equality booleans, per-field difference counts,
packet difference count, and both guide hashes. A different sample or import stops
analysis; a metadata mismatch also exits nonzero. Display differences remain
per-unit covariates in private analysis, and guide differences remain provenance.
No result is overwritten or selectively rerun. Changed assignment codes, categories,
families or subtype applicability refuse analysis; wording covariates do not permit
silently comparing a different classification task.

## Approval and completion gates

Keep the dated, approved plan outside the public repository. It must contain:

- `format`: `civicsample-ai-sample-comparison-plan-1.0`;
- `status`: `APPROVED`, `approved_at` with timezone, `approval_ref`, and the exact
  approved protocol's `protocol_sha256`;
- `unresolved_reference`: `REPORT_SEPARATELY_EXCLUDE_FROM_AGREEMENT`;
- `comparability_handling`: `REPORT_PER_UNIT_COVARIATES`;
- `screening_model_decision`: `status`, `recorded_at`, and `model`. Status must be
  `FIXED_BEFORE_HUMAN_EXPORT` with one of the existing model identifiers, or an
  explicit `NO_COHORT_SCREEN_PLANNED` with a null model. A pending cohort choice
  does not permit selecting a model after viewing agreement results.

An approved implementation is not permission to inspect interim answers. The CLI
validates this plan and the sample before opening human files. The v8.4 adapter
then validates two distinct completion receipts, their protocol/guide bindings and
timestamps, and the presence and timing of a closed snapshot before reading
judgment history. It then reconstructs and verifies that snapshot's content hash.
Approval recorded after the review-close snapshot is refused for this prespecified
analysis. The tool never silently relabels a later analysis as prespecified.

The supported input is the app's v8.4 export directory: `manifest.json`, `units.csv`,
`independent_judgments.csv`, `judgment_history.csv`, `subtype_observations.csv`,
`completion_protocol.json`, `reviewer_guide_current.md`, and `review_completions.csv`.
All consumed bytes must match the pinned manifest and its row counts. Initial and
effective answers, per-revision hashes, snapshot hashes and final completion
receipts must agree. R1 uses the **effective, locked** independent judgments.
Post-completion amendments that do not match these receipts are refused.

R2 additionally requires `final_reference.csv`, `final_answer_flags.csv`, a reference
lock timestamp and a separate explicit SHA-256 pin for `final_reference.csv` (the
adjudicated snapshot in this bundle). Two Agree or two Disagree answers must retain
their common answer. Every other pair must be routed. In particular, two Cannot
tell answers cannot use the older unadjudicated routing. The app's blank answer with
`UNRESOLVED` / `UNRESOLVED_ESCALATED` remains an **unresolved reference**, not Cannot
tell, a missing AI output, or a disagreement.

Older bundle versions and hand-built summaries without completion receipts are
refused. This adapter is for descriptive sample agreement only; it does not replace
the app's full export validation or its sampling-weighted performance analysis.
The current app normally exports after reference lock; this tool does not add a
new pre-adjudication export route to the clinician app.

## Private report

```sh
python3 scripts/ai-mapping-review/compare_sample.py \
  --ai-input /private/staging/mapping-review.json --ai-sha256 AI_INPUT_SHA256 \
  --ledger /private/staging/mapping-review-ledger.json --ledger-sha256 LEDGER_SHA256 \
  --live-snapshot /private/staging/live-comparability.json --live-sha256 LIVE_CAPTURE_SHA256 \
  --review-bundle /private/staging/locked-review --manifest-sha256 MANIFEST_SHA256 \
  --analysis-plan /private/staging/approved-comparison-plan.json --plan-sha256 PLAN_SHA256 \
  --references both --adjudication-sha256 FINAL_REFERENCE_SHA256 \
  --private-output /private/staging/state/comparison
```

Use `--references R1` and omit `--adjudication-sha256` to exclude R2; the tool will not
read either adjudication file. The default is `both`. `--references R2` omits R1
membership tables, while still validating the independent judgments underlying the
reference. Separate diabetes observations and model consistency remain descriptive.

The output parent must already exist, outside every checkout. Each invocation
creates a new mode-0700 directory containing `SAMPLE_COMPARISON_REPORT_<utc>.md` and
`numbers_trace.csv`, both mode 0600. The report binds the trace's hash. Archive that
new directory under `state/comparison/` in the existing **private** store through its
ordinary reviewed commit workflow. The analysis command performs no Git push and
never writes a prior ledger. Do not put reports in public artifacts or job logs.

The report includes, separately for each family and model:

- R1 3 × 3 tables against each reviewer, plus a Missing model row and a reviewer
  pair-pattern table;
- R2 3 × 3 tables, with unresolved references in a separate count table;
- confirmations, directional disagreements, Cannot tell counts and equal-answer
  counts;
- descriptive agreement, Wilson 95% intervals and unweighted Cohen's kappa only
  when the family has at least 20 units and an eligible pair. The denominator is
  observed model/reference pairs after excluding missing model output and unresolved
  references. Degenerate kappa is undefined, never zero;
- model-to-model tables explicitly labelled consistency, and diabetes stated-type
  counts by family/category/role, outside membership agreement.

The trace records unit/category, model and reference roles, request hashes, answers,
pair patterns and comparability covariates. It contains no notes, registry text or
reviewer identities. There is no pooling, population weighting, model winner or
automatic study change. All runtime trace rows and agreement figures remain private.
Success stdout has exactly `units`, `models`, `families`, `reviewers_finished`,
`adjudication_present`, and `report_sha256`; errors have fixed refusal categories.

## Checks

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/ai-mapping-review -p 'test_*.py' -q
PYTHONDONTWRITEBYTECODE=1 node --test tests/ai-mapping-review.test.ts
git diff --check
```

Tests exercise fictional complete exports, per-field differences, independent
input hashes, option ordering, unfinished-review refusal before answer-file access,
receipt/history tampering, R1 isolation, R2 routing, unresolved/missing denominators,
known interval/kappa values, cumulative ledger accounting, file privacy and stdout
redaction. They are not a real clinician comparison or a served-app inspection.
