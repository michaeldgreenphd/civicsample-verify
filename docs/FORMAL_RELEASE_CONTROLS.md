# Investigator release controls

Migration 0042 adds explicit controls over the existing database guards. Applying it approves
nothing and changes no packet, answer, gate approval or phase. The controls are available in
**Mapping units → Study preparation** for a prepared v8.1 design. Other roles cannot call either
release endpoint. The database rechecks the investigator role, active account and second factor.

## Sequence

1. Check release status. This is read-only. It reports counts and unmet requirements without
   revealing interim answers, rationales or enumerable answer hashes.
2. Record the [sample-only reporting scope](DESCRIPTIVE_REVIEW_PLAN.md) and final-submission
   protocol. The reporting action adds an immutable specification of G-EST-01, retaining both
   its freeze and opening gates. It approves neither that gate nor a population estimator.
3. Complete and verify the synthetic rehearsal. Accept it by selecting its registered export
   and attesting to the [rehearsal checklist](FORMAL_REHEARSAL_CHECKLIST.md).
4. Record the three approved read-only worked examples separately. Review and approve every
   applicable specified study decision. A pending specification cannot be approved by the UI.
5. Freeze the verified sample. The database compares the actual inventory against the immutable
   preparation receipt and runs every existing freeze guard, including probability provenance.
6. Select two distinct active clinical reviewer accounts and record their qualifications. The
   server reads the original private intake queue; the browser cannot supply unit IDs. Enrollment
   and both 100-position queues are one transaction. A wrong frozen queue hash rolls back both.
7. Open clinical review as a separate confirmed action. Assignment alone permits no packet access
   or answer submission before opening. The reviewers may see their own unavailable queue entries.
8. After both reviewers finish and lock all 100 answers, close review. The close and final-answer
   snapshot occur in one transaction. The adjudicator then receives disagreements and all Cannot
   tell cases, including double Cannot tells.
9. Resolve or explicitly escalate every routed case, lock the reference, build and register its
   formal export. The separate diabetes observation is retained without adjudication.

Every action needs a fresh status checksum, a specific attestation and an unchecked-by-default
confirmation. The checksum includes gate versions, approvals, roster and lifecycle state. Database
serialization rechecks the plan after acquiring the transition lock. After a failed or uncertain
request, the UI requires a status refresh; it never assumes a timeout means no change occurred.

## Descriptive reporting

`scripts/summarize-mu84-bundle.ts` verifies a locked registered bundle before reporting counts,
family denominators, paired final-answer agreement and unweighted kappa. Area and condition-row
results remain separate; individual categories and subgroup checks use counts only. Unresolved
answers are a separate outcome. Empty or undefined statistics are null, never zero. Matching two
Cannot tell answers contributes to reviewer agreement but never to clinical confirmation.

No weights, confidence intervals or population estimates are produced. Sampling information
remains in the export for a separately documented later analysis. The report contains no trial
identifiers, registry text, rationales or account names. Local and synthetic-design exports stay
marked synthetic; an actual hosted FORMAL bundle is labeled FORMAL only after its reference lock.

## Operational limits

The controls do not provision accounts, transfer real examples, change deployment configuration,
approve an unspecified gate, certify hosted checks or contact clinicians. A new formal destination
needs separate synthetic pilot accounts for its local rehearsal requirement; actual reviewer
accounts cannot be reused as pilot accounts. The immutable preparation receipt is preserved.

Keep the reviewed private intake file available to the server when assigning reviewers, using the
existing `VERIFY_FORMAL_INTAKE_FILE` and `VERIFY_FORMAL_INTAKE_SHA256` settings. Never put its bytes,
the roster or credentials in the public repository. The service-role key is not used by the app.

The release-control test uses 100 fictional units and 200 final independent judgments on the full
SQL lineage. It checks role/MFA denial, stale plans, atomic assignment refusal, all pending gates,
finish locks, double Cannot tell adjudication and verified descriptive exports. A native PostgreSQL
variant runs in CI; hosted Supabase acceptance still requires observed evidence from that service.
