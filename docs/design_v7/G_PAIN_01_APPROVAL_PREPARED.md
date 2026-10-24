# Gate G-PAIN-01: approval prepared, not submitted

Prepared under engineering message v8.3, item 2. Nothing here is recorded in any database. The approval is the
investigator's own act in the application, with a second factor.

- Gate and version: G-PAIN-01, requirement version 3 (migration 0032).
- Decision record that the approval cites. The application fills it in from the requirement, so it is never typed:
  `investigator decisions 2026-10-23, addendum 8, item 40, and addendum 11, item 60, with rubric 7.1 (SHA-256 9ab8d6a9aa146b648358c7f3993068a8963146861a5d0b04ae5d6e1bda60cf46)`
- Suggested attestation, at least 20 characters, which the investigator may reword: "I approve gate G-PAIN-01 as decided
  in addendum 8, item 40 and addendum 11, item 60: the Pain row is a descriptive row of Figure 2, defined for reviewers by
  rubric 7.1, and the four Pain units keep their row-membership display."
- Where: investigator workspace, "Study decisions before the formal review", G-PAIN-01, "Your approval as investigator",
  then "Approve G-PAIN-01".
- Equivalent database call, shown for review only and never run from a script:
  `select public.rpc_mu7_approve_gate('G-PAIN-01', '<attestation>', '<decision record above>');`
- What it changes: the four Pain units stop waiting at the freeze (MU7-G29, MU7X-G10), and G-PAIN-01 shows as approved.
  It changes no unit, packet, assignment, design row or queue, and no freeze-bound hash (`tests/mu7-gates-v8-4.test.ts`).
- What it does not do: the freeze stays refused while G-EST-01, G-MH-V53, G-OQ-03, G-OQ-04, G-OVERLAP-01, G-PROV-01 or
  G-TEXT-01 is open, and the formal phase stays closed. Nothing is frozen, imported or opened.
- On staging, the approval needs migration 0032 applied first, which is a separate investigator authorization (the staging
  plan's apply step). On a database without 0032, the gate's current record is version 2 (addendum 8, item 40 alone).
- An approval cannot be withdrawn or replaced. A later re-specification of the gate would need a new approval of the new
  version.
