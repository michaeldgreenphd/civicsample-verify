# Exploratory removal and addition pilot

This is a separate follow-up on the same 100 real trial packets used in the completed
three-model mapping comparison. The word *pilot* describes the experiment's scope;
these are not synthetic practice cases. No clinical database, study assignment,
reviewer screen, frozen result, or original AI comparison is edited.

## Question and protocol

The original experiment judged one displayed mapping per trial. This experiment asks
whether each trial fits each of the ten therapeutic areas and ten condition rows.
The original clinician guide is carried byte-for-byte. Categories may overlap;
fitting one area never by itself excludes another. The four original subgroup
questions are not repeated as separate tasks here.

Sonnet 5.5 assesses all 20 labels for each trial. The application derives KEEP,
PROPOSE_REMOVE, PROPOSE_ADD, NO_CHANGE, or REVIEW from the assessment and verified
original membership. Uncertainty cannot authorize a change. A proposed change
requires a literal quotation from a displayed registry evidence field; MeSH indexing
alone is not accepted as that quotation. The program checks quotation existence,
not whether the quotation scientifically justifies the decision.

Opus 5.5 independently assesses the entire label catalog for every trial with a
proposed change or uncertainty, plus 20 controls selected before generation. Controls
are the first 20 unit IDs ranked by SHA-256 of
`label-pilot-1|input_sha256|unit_id`. This is a union, so there are 20–100 audit calls.
Both models receive the same source evidence and original labels, with no previous
AI responses or human judgments. The original Sonnet 5 results remain preserved;
this follow-up does not repeat that arm.

Proposals are research leads, not automatic corrections or clinical validation.
Opus agreement does not establish accuracy. Audit selection is enriched for problems,
so its agreement rate cannot be presented as performance across all trials. Report
area and condition proposals separately; keep new proposals separate from the
original 100-mapping comparison and from the clinical review. Any later evaluation
must identify the changed task and its 20-label-per-trial denominator.

## Original membership and provenance

`prepare_label_pilot.py` is offline and refuses to overwrite a file. It requires:

- The original 100-packet input and completed 300-answer ledger, each pinned by SHA-256.
- Complete original area flags (`v54_is_*`, including the Depression exception),
  with exact TRUE/FALSE values and one row per trial.
- The complete condition-category map and original diabetes/neoplasm KEEP/REMOVE
  tables. Missing rule records are errors, never implicit KEEP.
- The final condition-model frame for an independent positive-membership reconciliation.

Do not infer a negative label from absence in the model frame: eligibility and
exclusion filters can omit trials. The complete category map supplies membership;
the two exclusion rules are applied before the frame reconciliation. An uncovered
trial, duplicate, missing value, source mismatch, or disagreement with the original
displayed assignment blocks preparation. All source hashes stay in the private input.
The builder is specific to these verified source column contracts; it does not
reconstruct new research rules or redraw the sample.

## Budget and failure behavior

The pilot has a maximum $20 sub-cap. Its costs plus the completed comparison's actual
charges **and retained uncertain reservation** must fit within the previously
authorized $95 combined ceiling. It cannot reset or omit the original spend. Standard
uncached prices are inherited from the original runner; no batch/caching discount is
assumed. No paid call happens until its conservative reservation is durably pushed
to the private store. An unresolved call, output truncation, invalid quotation, wrong
model, unexpected billing category, or checkpoint failure stops the run. A later
invocation refuses an unresolved reservation instead of automatically retrying it.
A fully validated completion is reused without a new paid request.

The dry-run reservation total assumes maximum outputs for every possible audit and
is not a predicted bill. It can exceed $20; the per-request budget checks stop before
crossing the sub-cap. A larger or different experiment requires its own reviewed
protocol and accounting of all previous spend.

## Running through GitHub Actions

Use the **Private exploratory label pilot** manual workflow on reviewed `main`.
It uses the existing `ai-mapping-review` approval environment and shares the original
workflow's non-cancelling concurrency group. Pull requests and pushes never generate
answers. There is no deployment or public artifact upload.

The existing `ANTHROPIC_API_KEY`, `PRIVATE_STORE_TOKEN` and `PRIVATE_STORE_REPO` are
reused. Two separate secret pins, `AI_LABEL_STORE_REF` and `AI_LABEL_INPUT_SHA256`,
identify the private commit and new input without replacing the original pins.

1. Prepare the private input outside every checkout using the source files above.
2. Add it to the verified private repository as `inputs/label-pilot.json` and pin
   that commit and the input SHA-256. The original ledger at this commit must be
   identical to the private repository's current ledger.
3. Dispatch `dry-run`, then `preflight`. Preflight only checks model access and
   counts all 200 possible prompts. It sends the private evidence to the provider
   for token counting but does not generate answers or modify the paid ledger.
4. Dispatch `run` with the spending reference and cap. An input-, settings-, and
   request-bound successful preflight is mandatory before generation.
5. Inspect the private results. Neither the runner nor the workflow applies labels.

New state paths are `state/label-pilot-ledger.json` and
`state/label-pilot-preflight.json`. Only those two paths are writable by this runner.
The baseline input, ledger and preflight are preserved. Public output is limited to
fixed statuses, counts, token totals and costs; provider diagnostics remain private.

## Verification

Run `python3 -m unittest discover -s scripts/ai-mapping-review -p 'test_*.py' -q`.
Tests use fictional evidence and mocked services, covering original-result validation,
complete membership, label polarity, quotations, model isolation, predetermined
controls, resumability, durable reservations, both budget ceilings, preflight binding,
fixed private paths, and the manual-only workflow. They do not establish that live
model generation, GitHub approval, or private checkpointing will succeed; those are
reported separately for an actual run.

## Revalidating a whole short registered condition

The first live pilot exposed a validation bug: an entire registered condition name
can be shorter than the eight-character quotation minimum. The corrected validator
accepts a 2–7-character quotation only when it equals the **entire** named
`conditions_registered.<index>` field, character for character. Short fragments,
other fields, case changes, invented text, empty strings, and single characters do
not qualify. All existing quotation-length and source checks remain for other text.
The prompts, catalog, rubric, original labels, request hashes, and audit selection
stay unchanged. This is a source-validation correction, not a changed clinical rule.

A halted run is never silently resumed. The manual `recover-evidence` operation,
with `--reconcile-stored-response` in the CLI, revalidates the already-paid saved
response without an API key or another model call. It requires the existing cap,
authorization reference, pinned inputs/baseline, and successful preflight. Only one
final `invalid_evidence` receipt that fails the old eight-character rule and passes
every corrected response check can be reconciled. Unknown charges, transport
failures, fabricated quotations, other invalid responses, and changed billing or
request records remain refused.

Recovery creates ledger format 1.1. Its `evidence_recovery` archive holds the complete
unchanged previous ledger, its SHA-256, the recovery source commit and time. All
previously completed records remain identical. The repaired receipt retains the raw
model response, original failure category, reservation and actual charge; its answer
is extracted unchanged from that response, and `completed_at` records the revalidation
time. Resume verifies both the archive and the repaired prefix, then validates every
later completion normally. Older runners refuse this format rather than ignoring the
archive. A second recovery is refused.

After review and merge, dispatch `recover-evidence`, inspect its result, then dispatch
`run` separately. The resumed run skips the recovered request. Recovery does not
reset the budget, rewrite the original comparison, or approve any study action.
