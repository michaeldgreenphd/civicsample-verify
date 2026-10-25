# V8 export consistency checks

The synthetic v8 analysis now checks that the final reference follows the
independent judgments and the adjudication fields in the same export. Previously,
a concordant Agree reference could be changed to Disagree and accepted if its CSV
checksum was recomputed. That defect was reproduced before this change and is
covered by regression tests.

## Enforced relationships

- Both reference copies of each reviewer's initial and effective answer match
  `independent_judgments.csv` exactly.
- Reviewer answers, judgment statuses, uncertainty flags and revision counts are
  explicit and valid. An unanswered assignment has no answer, uncertainty, note,
  submission time or revision. Initial and effective payloads cannot differ when
  the revision count is zero; submission timestamps are ordered and timezone-aware.
- Concordance, both Cannot tell, incomplete review and disagreement routing follow
  the current database views. A non-routed unit cannot carry an adjudication.
- Resolved adjudication requires a determinate answer and a basis consistent with
  the effective reviewer answers. Unresolved adjudication has no final answer or
  selected reviewer. A routed unit without completed adjudication is refused.
- Manifest row counts, frozen unit count, design version, assignment-set identifier
  and overlap setting agree with the CSVs. Each stratum has one consistent frame
  size and sample size. Unit roles also match between units and final references.

These checks preserve the current database contract. They do not adopt pending
clinical definitions or approve the proposed estimators, allocation or sample.
The family-separation regression now changes both reviewers' synthetic answers
and the derived reference together, rather than manufacturing an inconsistent
export to test the estimator.

## Limits

These are internal consistency checks, not authentication of an untrusted bundle.
Someone able to rewrite every file and manifest can make a different internally
consistent bundle. The current four-file format contains the initial and effective
judgments but omits intermediate revisions, per-judgment content hashes and exact
snapshot timestamp precision. It cannot independently reproduce the database's
full snapshot hash. Database-side snapshot validation still applies when exporting;
a future versioned export must carry enough history, with a trusted provenance
anchor, before the offline analysis can claim full independent verification.

Queue and packet freeze checks, provenance for the externally supplied inclusion
probabilities, and full history authentication remain separate follow-up work.
Real-design analysis is still refused even with `--allow-synthetic`.

## Verification

See the associated pull request for executed results. Tests use fictional bundles
and disposable databases only. No shared Supabase records, practice sessions,
scientific gate approvals or deployment are changed by this Python-only increment.

Executed locally on 2026-10-24:

- `MU7_ALLOW_NO_DB_BUNDLE=1 MU8_ALLOW_NO_DB_BUNDLE=1 <analysis-python> -m pytest -q analysis`:
  489 passed, three explicit standalone bundle skips.
- `MU8_ALLOW_NO_DB_BUNDLE=1 <analysis-python> -m pytest -q analysis/v8`:
  92 passed, two explicit standalone bundle skips.
- `VERIFY_ANALYSIS_PYTHON=<analysis-python> node --import tsx --test tests/mu8-roundtrip.test.ts`:
  five passed, one local native PostgreSQL skip. Both application-written v8
  alternatives passed the database-to-Python checks without a skip.

`<analysis-python>` denotes the local interpreter with `analysis/requirements.txt`
installed. Native PostgreSQL is unavailable locally; CI exercises its disposable
PostgreSQL 16 database. Live Supabase is not tested by this increment.

The Node suite run within `npm run check` passed 255 tests with zero failures,
33 reported skips and one existing todo; typecheck and lint passed. `npm run build`
passed with 36 SQL inputs and no local runtime files in the production trace.
Changed Markdown formatting and `git diff --check` passed. Browser checks were
not repeated for this Python-only change; no served application code changed.

The fixture scan and all three leakage commands completed successfully with zero
violations. The full `npm run check` command exited successfully.
