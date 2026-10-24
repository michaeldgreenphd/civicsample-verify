# Study-decision gates after migration 0032 (engineering messages v8.3 and v8.4)

What the database enforces on this branch. A gate that holds the freeze makes `rpc_mu7_freeze` refuse (MU7X-G06; for the
four Pain units also MU7-G29 and MU7X-G10) until the gate's latest requirement version is SPECIFIED and the investigator
has approved that version, naming its decision record. A gate that holds the opening makes
`rpc_mu7_phase('FORMAL_OPENED')` refuse on the same condition (MU7X-G07). The opening also needs the pilot sign-off, the
freeze, both full FORMAL queues and the worked examples (MU7-G44, MU7-G31, MU7-G41), and the investigator's written
instruction (APP_IMPORT_STEPS_v7.md, step 6).

| Gate         | Holds the freeze                        | Holds the opening | Latest requirement                                                                         | Decision status                                                                                                             |
| ------------ | --------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| G-PAIN-01    | the four Pain units (MU7-G29, MU7X-G10) | yes               | version 3, SPECIFIED (0032): addendum 8, item 40 and addendum 11, item 60, with rubric 7.1 | decision recorded; the in-app approval is the investigator's act (prepared in `G_PAIN_01_APPROVAL_PREPARED.md`)             |
| G-MH-V53     | yes                                     | yes               | version 2, SPECIFIED (0028)                                                                | check passed on 2026-10-23 (v8.1, item 2); approval pending                                                                 |
| G-PROV-01    | yes                                     | yes               | version 1, PENDING_SPECIFICATION                                                           | proposed (PV04 to PV08 applied)                                                                                             |
| G-OVERLAP-01 | yes                                     | yes               | version 1, PENDING_SPECIFICATION                                                           | proposed (ALLOW)                                                                                                            |
| G-TEXT-01    | yes                                     | yes               | version 1, PENDING_SPECIFICATION                                                           | proposed texts                                                                                                              |
| G-OQ-03      | yes, since 0032                         | yes               | version 2, PENDING_SPECIFICATION (0032)                                                    | holding the freeze approved (investigator decisions of 2026-10-22, item 2; v8.4, item 1.2); the policy text awaits approval |
| G-OQ-04      | yes, since 0032                         | yes               | version 2, PENDING_SPECIFICATION (0032)                                                    | as G-OQ-03                                                                                                                  |
| G-EST-01     | yes, since 0032                         | yes               | version 2, PENDING_SPECIFICATION (0032)                                                    | holding the freeze: investigator instruction of 2026-10-24; the estimator itself is not approved                            |
| G-PROV-02    | no                                      | no                | version 1, PENDING_SPECIFICATION, holds nothing                                            | default stands (v8.4, item 1.3)                                                                                             |
| G-PROV-03    | no                                      | no                | version 1, PENDING_SPECIFICATION, holds nothing                                            | default stands (v8.4, item 1.3)                                                                                             |

The rows of G-MH-V53, G-PROV-01, G-OVERLAP-01 and G-TEXT-01 are unchanged from migrations 0026 and 0028. They agree with the
matrix proposed in v8.4, item 2.1, which the investigator has not yet recorded; any change to them needs an investigator
decision and a new reviewed migration.

A pending gate becomes approvable only when a reviewed migration adds a SPECIFIED version that names the investigator's
decision record. The investigator then approves it in the application with a second factor, and the approval is stored
against that version (0029). Nothing in this repository approves a gate, and no test approval exists outside a disposable
test database.

Tests on the chain with 0032 (`tests/mu7-gates-v8-4.test.ts`, synthetic data only):

1. the matrix above, with nothing approved and the earlier requirement versions kept;
2. G-OQ-03, G-OQ-04 and G-EST-01 refuse an approval while pending (MU7X-G08), also through the application
   (`tests/mu7-app.test.ts`);
3. the freeze is refused while any one of the three is open, with every other gate met, and passes once it is met;
4. the formal opening still checks the three after the freeze;
5. approving G-PAIN-01 version 3 lifts the unit hold of the Pain units only, satisfies no other gate, and leaves the freeze
   refused while any freeze gate is open; an approval citing addendum 8, item 40 alone (version 2) is refused;
6. no gate approval changes the unit list, assignment set, design rows, packets or queue hashes, and all five frozen
   hashes verify (`rpc_mu7_verify_freeze`);
7. with every other gate met, G-PROV-02 and G-PROV-03 block neither the freeze nor the opening.

The tests of migrations 0026 to 0030 (`tests/mu7-lifecycle.test.ts`, `tests/mu7-gates-v8-1.test.ts`) run on the chain
before 0032 where they reach the freeze with 0026's matrix. The private dry run on a disposable copy should repeat check 6
against the recorded hashes of the proposed sample and the four Pain packets, which this public repository does not hold.
