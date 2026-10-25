# Handoff v8.1 revision 2: offline import compatibility

## Scope and investigator direction

On 2026-10-25 the investigator requested a **new proposed sample matching the final model's population**. The two existing draws remain engineering inputs only. Neither is selected or approved. Do not import either into the practice service or promote either into formal review because it passes this check.

Before a new draw, establish the final cohort/frame revision and its checksum, the condition-row and subgroup frames, and the proposed allocation method, overlap policy and seed. Record those inputs before drawing. Generate a new version of the sample, probabilities, assignments, queue and import package; preserve the old files. Recalculate the frame checks and exposure/exclusion checks for that version. A revised population can change the area ranking and therefore the six-and-five allocation: do not copy the previous allocations without checking the new frame.

This direction authorizes preparation of a proposal, not a freeze, gate approval, estimator approval or formal opening. Existing practice access is unaffected.

## Repeatable local check

From the repository root, with dependencies installed:

```sh
npm run --silent mu81:offline-import-check -- --private-dir /absolute/private/package/data_private
```

The directory must be outside every Git repository. The command reads the revision-2 `SHA256SUMS_PRIVATE.txt`, verifies its files, and tests **both** corrected alternatives. It accepts no database URL, account credentials or remote destination. It does not use the application's persistent `getDb()` loader. Each alternative receives a new in-memory PGlite instance, the complete hosted migration chain, and a synthetic investigator identity with simulated MFA claims.

It executes the actual design-record and import RPCs for 100 mappings. It checks the unit-list, assignment-set and design-row manifests against database-written values, verifies all 200 queue positions in memory (no queue is assigned), and compares each packet to the handoff's original canonical-JSON packet hash. It separately verifies the database's JSONB packet hashes. These two hash encodings are deliberately not equated.

For ONE_PER_TRIAL it submits the separately bound probability payload through the actual RPC, checks the returned binding digest against the private companion, and requires its source CSV to equal the supplied CSV bytes. The nominal n/N database guard is unchanged. ALLOW receives no binding.

The database must contain no gate approvals, freeze, queue assignments, phase events, judgments, adjudications, snapshot, reference lock or export when the check finishes. Both databases are closed and discarded. Output contains only fixed status fields, aggregate counts and booleans. Private exception messages are suppressed, since database errors can embed input parameters. No packet, private identifier, registry text or private hash is written to stdout or a report file.

A checksum proves consistency with the supplied checksum list, not independent authenticity of its author. The command does not assess scientific adequacy, implement a new draw, or approve a design. Future packages with changed filenames or schemas need explicit compatibility updates; they are not silently accepted.

## Rubric reconciliation

The candidate remains a candidate and is not copied into the served rubric. Confirmed engineering text matches the app's separate D4A/D4B question and three labels:

- Does the registry text state that the trial studies type 2 diabetes?
- Type 2 diabetes is stated / Type 2 diabetes is not stated / Cannot tell from this packet.

These answers remain separate from membership, required on those two unit types, unadjudicated, and count-only in reporting. Historical answers retain their meaning.

**Should fix in the candidate:** its section 4 sentence “A stated diabetes type is never a reason code” and section 7 sentence “a stated type is never an adjudication reason” are broader than the approved implementation. The change removes `TYPE_2_STATED` for D4A/D4B only. Other diabetes units retain membership reasons such as `TYPE_2_STUDIED` and `TYPE_1_ONLY`. Narrow the sentences to D4A/D4B and that removed code; do not remove the other valid reasons. Evidence: candidate rubric lines 213 and 262; app vocabulary in `src/lib/mu7-types.ts`, design-specific filters in `src/server/mu7-core.ts`, and migration 0035.

The revised Cannot-tell wording, clinical definitions, Rule K texts, illustrations and estimator remain unresolved as marked by the handoff. A successful import is not evidence that those decisions have been approved.

## Remaining release checks

The final model's frame and the new proposed package are still required. Re-run this compatibility check against an explicitly supported new package, resolve the scientific gates in the investigator workflow, obtain independent code review, and perform the authorized live staging checks with real JWTs. PGlite uses a local auth shim; it does not verify deployed Supabase authentication, MFA, PostgREST or RLS configuration. Nothing in this increment deploys or changes the live practice app.
