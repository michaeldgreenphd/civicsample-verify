# Three-model comparison on the clinician mapping task

This runner implements a **separate AI assessment of the same 100 trial-to-category mappings** that the physicians are being asked to assess. It does not run the older descriptor-to-area ontology experiment. It does not create, replace, display or adjudicate any human judgment, and it cannot open formal review.

The investigator requested Sonnet 5, Sonnet 5.5 and Opus 5.5, with total API spending below USD 100. This implementation sets a combined ceiling of **USD 95**, shared across all three models and resumes. It makes at most 300 successful assessments: one independent request per model per mapping. A packet or rubric proposal remains a proposal when passed to this runner. Its answers are not study performance results until the frozen human-reference comparison and its analysis are separately established.

## Implemented and still outstanding

Implemented: strict checksummed input validation; identical displayed wording, evidence and guide in each arm; offline cost bounds; account model-access checking; explicit paid-command opt-in; durable reservations before calls; resumable completed responses; refusal to retry uncertain or failed requests automatically; strict response validation; and a manual GitHub Actions workflow.

Outstanding before execution: reviewed code on the default branch, a private data repository and scoped store token, approved input-byte pin, configured workflow environment, and an executed account-access check. No API request or paid run is implied by local tests. The private-store clone/push and real model calls have not been tested against live services. Existing `ANTHROPIC_API_KEY` configuration does not install or run the workflow.

## Input fidelity

The app-side preparer writes `civicsample-ai-mapping-input-1.0` outside every public checkout. It contains:

- Exact guide text, profile identifier and SHA-256.
- Source application commit, sample-list checksum and prepared-import checksum.
- Exactly 100 unique units with the allowlisted reviewer packet, the actual displayed title/question/assertion/inclusion polarity, the three displayed response options, permitted disagreement reasons and the subtype requirement.

The runner refuses extra fields, hidden review metadata, bad checksums, duplicate units, missing units, unknown response options, and inconsistent subtype requirements. Only rendered intervention names/types are sent; unrendered intervention descriptions are excluded. No sampling fields or human answers enter model prompts. Registry text is treated as untrusted evidence; no browser, search or tool is supplied. Each arm sees the same input except for its requested model identifier.

For D4A/D4B units the separate question is exactly: “Does the registry text state that the trial studies type 2 diabetes?” It has the same three response labels as the app. It is required independently of Agree/Disagree/Cannot tell and is not adjudicated. An unstated type is not relabelled as type 2.

## Request settings and billing

| Arm        | API identifier      | USD / million input tokens | USD / million output tokens |
| ---------- | ------------------- | -------------------------- | --------------------------- |
| Sonnet 5   | `claude-sonnet-5`   | 2                          | 10                          |
| Sonnet 5.5 | `claude-sonnet-5-5` | 2                          | 10                          |
| Opus 5.5   | `claude-opus-5-5`   | 4                          | 20                          |

Prices and identifiers were checked against the official [Sonnet 5](https://platform.claude.com/docs/en/models/sonnet-5/overview), [Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview) and [Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/overview) documentation on 2026-10-25. The runner uses API version `2026-10-21` and the documented Bearer API-key header ([migration reference](https://platform.claude.com/docs/en/api/migration-2026-10-21)), explicit adaptive thinking, medium effort, a 4,096-token output limit including thinking, structured JSON, and standard service. The same effort label does not imply equal compute. This is a new comparison configuration, not the earlier thinking-off replay; Opus 5.5 cannot disable thinking. There is no temperature override, cache write, batch discount, web tool or silent fallback to another model.

Before each potentially billable request, the runner reserves an intentionally conservative cost: one input token per serialized UTF-8 byte plus 8,192 framing tokens, and the full permitted output. It stops if that reservation would exceed the combined cap. On a valid response it records the provider's actual usage at the pinned prices. Returned model, usage, settings and request checksum are preserved privately. A response whose usage exceeds the reservation stops the run immediately. Provider pricing and actual invoices are external, so also configure a provider workspace/account spending limit; the runner is not a billing guarantee against price changes or other clients using the same account.

A timeout, malformed answer, model mismatch, truncated output, unexpected billing category or failed checkpoint stops further calls. A reserved/unreconciled entry prevents automatic resume until a separate reviewed reconciliation establishes what was charged and whether a valid result exists. Response notes obey the same 2,000-character limit as the physician form. Completed results are revalidated and skipped on resume. Changing the input, approval, cap, request shape or prices refuses reuse of the ledger. No code resets it to obtain a fresh budget.

## Private store and workflow setup

Use a separate **private** GitHub repository as a data store. Its clone is used only as data; hooks and executable files from it are never run. Its layout is:

```text
inputs/mapping-review.json
state/mapping-review-ledger.json  # created by the runner; contains raw responses
```

Create a fine-grained token limited to **Contents: read/write on that private repository**. Do not grant it organization administration or broad repository access. In the app repository, configure the `ai-mapping-review` environment with a required investigator reviewer and permitted default branch. The workflow is `workflow_dispatch` only; it does not run on pushes, PRs, forks or schedules, and its job refuses non-default branches.

Set these configuration entries privately:

| Entry                     | Kind     | Purpose                                                  |
| ------------------------- | -------- | -------------------------------------------------------- |
| `ANTHROPIC_API_KEY`       | Secret   | Existing provider key, available only to the runner step |
| `PRIVATE_STORE_REPO`      | Variable | Owner/name of the private data repository                |
| `PRIVATE_STORE_TOKEN`     | Secret   | Token limited to that repository                         |
| `AI_MAPPING_STORE_REF`    | Secret   | Exact 40-character commit containing the reviewed input  |
| `AI_MAPPING_INPUT_SHA256` | Secret   | Expected SHA-256 of the input file at that commit        |

Source pins are secrets to keep private sample fingerprints out of public workflow inputs. The runner verifies the destination is a private GitHub repository before cloning. Input is read from the fixed path at the pinned commit; the single ledger is loaded from the current default branch. All writes are ordinary commits and pushes to the private repository. A failed push stops processing, and a reservation is pushed **before** its paid request. No force-push, history deletion, public artifact upload or printout of packets, response text, hashes, credentials or identifiers is used. Public output contains only fixed status categories, model/request counts and budget totals.

The workflow must be present on the app repository's default branch to appear for manual dispatch. Merging and environment/data-store configuration remain explicit release steps; a draft PR alone does not make it runnable.

## Operations

1. Run the offline tests. All calls in them are mocked and all evidence is fictional:

   ```sh
   python3 -m unittest discover -s scripts/ai-mapping-review -p 'test_*.py' -q
   node --test tests/ai-mapping-review.test.ts
   ```

2. Prepare the input privately through the app's checked source-preparation path. An offline local check is available without a key:

   ```sh
   python3 scripts/ai-mapping-review/runner.py dry-run \
     --input /absolute/private/mapping-review.json \
     --input-sha256 THE_LOCALLY_VERIFIED_DIGEST
   ```

3. After configuring private storage, dispatch `dry-run`. This fetches the private input and validates it but makes no Anthropic request. Review the conservative cost bound; it is not an observed bill.
4. Dispatch `models` to verify all three requested identifiers are available to this account. This performs model-metadata GET requests only, not generation. Failure stops preparation; models are not silently substituted.
5. Dispatch `run` only with the investigator spending-authorization reference and a combined cap of 95 or lower. The workflow translates this explicit choice to `--execute-paid`. Keep the same cap, approval and input when resuming.
6. Read results only in the private ledger. Do not share per-unit AI answers with reviewers or the adjudicator. Model consistency is not clinical validity; this runner prints no accuracy claim, selected “winner”, or human-reference estimate.

A cancelled job may leave a durable reserved request. Do not delete or reset its ledger to restart. Reconcile that request first; this conservative behavior avoids charging twice for an uncertain call. The runner serializes jobs with a non-cancelling concurrency group and processes one request at a time.
