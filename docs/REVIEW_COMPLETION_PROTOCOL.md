# Final submission and all-Cannot-tell adjudication

This increment implements the investigator's October 27 workflow decisions. It does not choose
an estimator, approve gates, select a sample, freeze, open review or change a deployed database.

## Compatibility

Migration `0040_v84_reviewer_completion.sql` is additive. Applying it alone changes no review
mode. An investigator with MFA must explicitly bind `mu84-finish-and-adjudicate-1` to PILOT or
FORMAL **before that mode has any answers, adjudications, reference lock or formal freeze**.
The binding requires the existing guide-4 reviewer profile. An earlier completed practice mode
can coexist with a new formal protocol; guide 4 and its profile remain immutable provenance.

Guide revision 5 changes only final submission and adjudication instructions. Its SHA-256 is
`03cc9a6617aae436bbbc73c6a8d2b792d3808ecebd6b661133e942df4408595e`.
The formal freeze binds the additional protocol checksum. Guide-4 and older modes retain their
existing completion and both-Cannot-tell semantics and export versions. No existing judgments
are rewritten. Binding in FORMAL is an operational investigator action, not an approval implied
by this migration. The app offers a local synthetic pilot opt-in only.

## Reviewer and adjudicator behavior

- Saving records an immutable revision. The latest saved revision counts when the reviewer
  deliberately confirms **Finish my review**. Every assigned mapping must be answered; a formal
  receipt requires exactly 100 mappings.
- The confirmation names the current saved-answer checksum. A save in another browser tab makes
  that confirmation stale. The finish and save operations serialize; whichever commits first
  determines the refusal or receipt. A repeated finish with the same answers is idempotent.
- After finish, all further answer writes for that reviewer/mode are refused in PostgreSQL,
  including direct RPC calls. The UI remains readable and shows the completion time. There is
  no overwrite, unlock or amendment endpoint in this increment. A needed amendment must have
  its own explicitly authorized, append-only procedure before any later implementation.
- Both reviewers must finish before complete closure. Formal adjudication also waits for the
  existing investigator close and snapshot. Practice waits for both completion receipts.
- Any Cannot tell routes to the adjudicator, including two Cannot tells. A resolved tie-break
  does not erase the separate `both_final_cannot_tell` flag on the two locked independent answers.
- The diabetes stated-type observation remains a required separate answer on eligible units.
  It is part of the saved-content hash and completion receipt and is never adjudicated.

The two receipts are private to their owners during open formal review. The investigator's audit
channel contains keyed digests and counts, not enumerable answer or receipt hashes. No reviewer
can retrieve the other reviewer's completion, answers or progress through the new helper calls.

## Bundle 8.4 and analysis boundary

A completed protocol mode exports bundle **8.4**, preserving the 8.3 files and adding:

| File                        | Content                                                          |
| --------------------------- | ---------------------------------------------------------------- |
| `completion_protocol.json`  | Mode, fixed protocol, guide and profile binding hashes           |
| `reviewer_guide_current.md` | Exact guide-5 bytes; `reviewer_guide.md` retains guide 4         |
| `review_completions.csv`    | Two receipts, complete answer inventories, timestamps and hashes |
| `final_answer_flags.csv`    | One both-final-Cannot-tell flag per mapping                      |

Receipt canonicalization is sorted by unit ID using code-point order, one line per latest
independent judgment: `unit_id|reviewer_slot|assignment_id|revision_number|content_sha256`.
Lines use LF with no trailing LF. Receipt SHA-256 binds
`mu84-completion-receipt-1|mode|reviewer_pseudo_id|protocol_binding_sha256|answers_sha256`.
The authoritative registered manifest checksum authenticates the downloaded file set. A
self-consistent unregistered manifest alone is not proof that the database produced it.

The offline verifier checks the receipt inventories against the complete revision history,
final answers, routing, flag inventory, guide and frozen protocol. It refuses a downgraded
format carrying the new frozen protocol. Previous format readers remain available; existing
Python population analysis refuses 8.4 until its method is explicitly updated and approved.

The new report is **sample counts only**:

```sh
node --import tsx scripts/summarize-mu84-bundle.ts \
  --bundle /absolute/private/export \
  --expect-manifest-sha256 <registered-manifest-hash>
```

It emits counts by family and category, final independent cross-tables, confirmed/not confirmed/
unresolved/missing counts, the both-Cannot-tell flag, saved revisions, and first/final diabetes
observations. It emits no trial IDs, free text, population percentage, interval, kappa, weighting
or unapproved sensitivity analysis. Practice remains explicitly synthetic and separate.

## Verification and release

Tests use disposable synthetic databases and intercepted synthetic browser DTOs. Native tests
exercise both finish/save interleavings plus the complete 100-mapping lifecycle. The hosted
PostgreSQL job runs them with `VERIFY_PG_REQUIRE=1`. Actual Supabase JWT/RLS and hosted-browser
checks remain necessary before a release; a green local PGlite test does not substitute for them.
See the dated test run for commands and observed results. Existing practice records and the
prepared real sample must be preserved during any separately authorized upgrade.
