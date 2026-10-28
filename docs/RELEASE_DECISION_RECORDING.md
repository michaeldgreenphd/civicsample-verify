# Recording the release decisions

Migration 0043 adds an investigator-only operation that turns eleven pending gate
questions into specific, evidence-bound questions for the current prepared v8.1
sample. It does not approve a decision. G-EST-01 is specified separately through
the descriptive reporting control introduced in migration 0042.

An operator supplies exactly one checked document reference and SHA-256 per gate
to `rpc_mu84_record_release_specifications`. Use the signed-in investigator's own
MFA-verified session. References belong in the private operational record, not in
the public repository. The operator must actually verify the supporting files;
the database can validate checksums and provenance bindings, but cannot determine
whether a document's scientific assertions are true.

The operation binds the immutable intake, actual recorded inventory, probability
binding, revision-4 clinical guide and revision-5 final-submission protocol. It
requires 100 different trials, 56 area mappings across all ten areas, 40 condition
rows and four subgroup checks. Every existing freeze/opening blocker is retained.
It refuses changed inventories, stale plans, duplicate evidence entries, repeat
recording, prior approvals and post-freeze activity. The evidence receipt is
append-only and visible only to an investigator with a second factor.

After recording, the investigator reviews each question in Mapping units and uses
the existing separate approval control. Specification does not approve the sample,
the rubric, the provenance findings, the reviewer exposure statement or opening.
The repeated-trial question explicitly preserves probability provenance while
deferring any weighted population analysis. Formal review remains closed until
the rehearsal, all applicable approvals, freeze and assignments are complete.
