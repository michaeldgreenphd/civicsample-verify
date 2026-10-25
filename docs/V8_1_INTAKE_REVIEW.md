# V8.1 reconciliation: engineering intake

Status: reviewed as a proposal, not applied to the served application. The supplied
sanitized developer handoff contains 31 checksum-listed files plus its checksum
manifest; all 31 matched when read on 2026-10-24. No source archive or private sample
was copied into this repository. Scientific recommendations remain pending.

## Compatibility findings

1. **Before ONE_PER_TRIAL import: bind non-nominal probabilities through an additive
   design version.** `private.mu7_unit_design_before_insert` in migration 0024
   currently enforces `selection_probability = n_h / N_h` for all rows. A disposable
   full-lineage database reproduced MU7-G20 refusing a synthetic v8 ONE_PER_TRIAL
   row with a non-nominal probability. The proposed probability-bearing import
   cannot simply be loaded unchanged. After the approved probability/provenance
   specification exists, an additive migration must bind its digest and row values,
   require that binding at freeze, and preserve the old nominal rule for old
   designs. Do not relax the existing guard globally. The current synthetic
   round-trip tests use nominal design rows and a separate fictional analysis
   probability file; they do not establish this private-import capability.
2. **Clarify the answer model for `TYPE_2_STATED`.** The proposed meaning says this
   can clarify the diabetes type without challenging KEEP. The current
   `mu7_judgments_reason_ck` constraint requires a reason if and only if the answer
   is DISAGREE, and `src/app/mu7-workspace.tsx` submits a reason only for Disagree.
   A wording-only change cannot record a structured Agree-plus-clarification.
   Request an explicit specification: a separate non-judgment annotation, or an
   explicitly different question about the subtype label. Do not turn a correct
   KEEP into Disagree implicitly, or reinterpret historical disagreement codes.
3. **Version the vocabulary at every boundary.** `src/lib/mu7-types.ts` currently
   takes reason lists from the v7 contract; `src/server/mu7-core.ts` uses those
   lists for reviewer and adjudicator DTOs. Database packet checks use canonical
   labels/texts. New rule-K labels, offered reasons and stored-code acceptance need
   a versioned contract across all of them. Existing v7 stored packets, judgments,
   training and exports must retain their original meaning. An additive SQL file
   alone is not enough if shared UI constants are replaced globally.
4. **Resolve the unchanged-import instruction.** The draft handoff both asks for
   unchanged ONE_PER_TRIAL import and proposes rebuilding two subgroup packets.
   These can preserve membership, assignments and queue order, but the original
   import bytes and packet inventory digest cannot remain unchanged. An approved
   revision must name the new packet/import artifact and its checksums, while
   explicitly verifying the preserved membership/design/assignment/queue hashes.

These findings concern implementation compatibility, not approval or rejection of
clinical definitions. They should be resolved in the final developer specification.

## What stays pending

- Clinical policy choices, final rubric bytes/version and their investigator gate
  records, including the Pain carry-forward and mental-health frame approval.
- The estimator and probability binding specification. Calibrated weights,
  subgroup agreement reporting and the proposed variance interpretation were not
  implemented. The supplied statistical brief says coverage was not re-simulated
  for ONE_PER_TRIAL; planning precision is not verification of interval coverage.
- Rule-book exposure and signer decisions. The handoff explicitly marks its v8
  overlap recount as provisional; this intake did not run or independently verify
  that recount. The supplied mental-health and provenance checks were not rerun.
- Real sample selection/import, formal opening and any live deployment.

## Engineering completed independently

The existing synthetic v8 analyzer now recomputes queue and packet-inventory
hashes from the four-file export, verifies canonical row digests, and rejects
missing/duplicated positions and missing/inconsistent reviewer identities.
Application-generated bundles pass these checks. No proposed clinical text,
estimator or reason-code changes were loaded. See `V8_EXPORT_INTEGRITY.md` for
what these checks do and do not establish.
