# v8.1 subtype observations and probability provenance

The investigator authorized these two engineering choices in this conversation:

- Require a separate diabetes subtype observation on D4A/D4B judgments, without adjudicating it.
- Bind Monte Carlo probabilities separately; keep `selection_probability` as nominal n/N.

This does not approve the rubric as a whole, estimator, sample, overlap alternative, any study gate, freeze, deployment or formal opening. The new behavior applies only to a **new** `review-design-v8.1.0` or `SYN-8-1-*` design. The application's setup button continues to create the existing synthetic v7 practice design. No existing database is converted or seeded by this work.

## Compatibility and question

Migration 0035 adds a nullable `diabetes_subtype` column on each judgment revision. For the new vocabulary it is required exactly on `D4A_KEEP_UNRESOLVED_PARENT_ONLY` and `D4B_KEEP_UNRESOLVED_COMPLICATION_ONLY`, with these states:

- `TYPE_2_STATED`: Type 2 diabetes is stated.
- `TYPE_2_NOT_STATED`: Type 2 diabetes is not stated.
- `CANNOT_TELL_FROM_PACKET`: Cannot tell from this packet.

The question is “Does the registry text state that the trial studies type 2 diabetes?” It is required for Agree, Disagree and Cannot tell, including revisions. Other units reject the field. It neither sets membership nor changes adjudication routing. Stated type is removed from the new D4A/D4B disagreement lists, including adjudication reasons. Older v7/v8.0 answers retain their original meaning and hash construction.

For v8.1, the content digest is SHA-256 of `mu81-judgment-1|<existing judgment digest>|<subtype or empty>`. The existing immutable revision history, shared phase locks, snapshot, keyed audit digest and role checks remain. Reviewer DTOs contain only their own subtype observations. The adjudication UI has no subtype decision or control.

## Probability artifact contract

MU7-G20 is unchanged. The probability artifact supplements nominal n/N; it cannot override it. Migration 0035 adds an append-only, investigator-readable binding with no direct application-role writes. `rpc_mu81_bind_probabilities(p)` requires an active investigator with the existing MFA requirement. It serializes with freeze using the existing module transaction lock and requires READ COMMITTED.

A digest-only audit event records its creation; source rows never enter audit payloads. The binding contains:

- `binding_version = mu81-probability-1`, design version, `method = MONTE_CARLO_ONE_PER_TRIAL`.
- Replicate count (>1), seed (matching every imported design row), original probability CSV bytes and their SHA-256.
- Canonical rows, their SHA-256, and a digest binding all metadata to that file and row digest.

The original probability file is **not rewritten**. Its supported header is:

```text
unit_id,stratum,N_h,n_h,nominal_probability_n_h_over_N_h,pi_mc_ONE_PER_TRIAL,mc_se,pattern_group_units,weight_ONE_PER_TRIAL,ratio_mc_to_nominal
```

The parser accepts the supplied simple UTF-8, unquoted, LF-terminated CSV contract. Unsupported serializations are refused. The database verifies each source row's unit, stratum, N, n, nominal fraction, pi and Monte Carlo error against the binding/imported design. Derived weight and ratio columns are retained as source evidence but not used to compute analysis weights.

Canonical rows use unit IDs sorted by code point and the text `unit_id,pi_i,mc_standard_error\n`, **without a header**, including the last LF. Decimal strings use ordinary notation with no exponent, no leading zeros other than `0.`, and no insignificant trailing zeros; at most 30 fractional digits. Zero is `0`, one is `1`. Conversion is exact; unsupported precision is refused rather than rounded. Inclusion probabilities must be in (0,1], and standard errors in [0,1].

The binding digest is SHA-256 of the following pipe-separated values:

```text
binding_version|design_version|method|replicates|seed|file_sha256|rows_sha256
```

Exactly one row per planned FORMAL unit is required; duplicates, incomplete coverage, wrong seed, changed file, changed row digest or source/binding disagreement are refused. A new ONE_PER_TRIAL freeze requires the binding and stores its digest. ALLOW uses nominal probabilities and accepts no binding. Existing v8.0 synthetic fixtures remain compatible and do not acquire these new semantics.

To prepare a payload **without connecting to any database**, use:

```sh
python3 scripts/mu81-probability-plan.py --source /absolute/private/probabilities.csv --output /absolute/private/probability-binding.json --seed <recorded-seed> --replicates <recorded-count>
```

The output must be outside a Git repository, is created with owner-only permissions, cannot overwrite a file, and is never printed. An authorized future import may submit this payload to the RPC using the investigator's own token. No remote apply command or automatic import is included.

## Export and analysis

New designs write bundle **8.1**. Existing bundle 7.0 remains unchanged. The four membership CSVs retain their columns. Bundle 8.1 adds:

- `subtype_observations.csv`: one row per recorded revision, with membership answer, subtype and content digest. It includes blank subtype for ineligible units so history coverage can be checked.
- For ONE_PER_TRIAL, `probability_source.csv`: the exact original probability file, and `probabilities.csv`: the canonical three-column representation.
- The vocabulary version, probability metadata, and frozen binding digest in the manifest.

The analyzer checks original file bytes, canonical row digest, source-row equality, metadata digest and frozen binding before using pi. An external `--probabilities` override is refused for bundle 8.1. It reports subtype counts by reviewer, initial/effective answer and membership response, without adjudicating subtype or inferring a type-2 label.

The existing **synthetic-only** analysis restriction stays in force. Estimator calibration, variance, intervals and real-study analysis remain pending. The subtype export validates revision coverage and endpoints but does not independently authenticate the full database snapshot; the existing membership bundle omits intermediate revision rationale/timestamps. This remains a stated limitation, not a passed verification.

## Research handoff boundaries

This implements only the two explicitly approved addendum choices. Rule K wording, new clinical definitions, packet rebuilds, the proposed estimator and scientific gate approvals are outside this change. No private file, private checksum, unit identifier, registry text or operational response is copied into the repository. The research quote-checker's hard-coded pass is not accepted as evidence of verbatim source verification.
