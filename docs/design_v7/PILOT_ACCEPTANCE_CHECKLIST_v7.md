# Pilot acceptance checklist, review design v7 (PAC-7)

The investigator signs off the pilot (`rpc_mu7_phase('PILOT_SIGNED_OFF', ...)` with checklist_version "PAC-7", the
SHA-256 of this file, the app git SHA and the pilot export ID) only when every item holds. Synthetic data only.

Database and tests
- [ ] NNNN reviewed and merged as a pull request; the migration number assigned; no earlier migration edited.
- [ ] The PGlite suite passes on the merged migration (362 steps in this package); the mutation harness kills every
      mutation; the earlier suites show only the traced differences of SCHEMA_TEST_REPORT_v7.md.
- [ ] The same behaviours (BEHAVIOR_TEST_SPEC_v7.md) pass on live PostgreSQL 16 and on Supabase staging with real JWTs,
      including: no reviewer reads the other reviewer through any table, view or function; no interim look.
- [ ] The five existing synthetic staging accounts are kept and still sign in with their roles.

Pilot run (SYNTHETIC_PILOT_UNITS_v7.json)
- [ ] All 12 pilot units imported from `units[i].import`; no walkthrough field reached the database.
- [ ] Each reviewer sees 8 primary units first; subgroup units stay unavailable until all 8 are answered; the subgroup
      screen restates the parent row and the KEEP or REMOVE decision.
- [ ] The Mental health unit shows the D003863 note in the canonical wording.
- [ ] A DISAGREE without a reason code or a note is refused with the guard message; a reason code that does not fit is
      refused.
- [ ] Routing equals `expected_routing` for every unit (5 routed, 1 both CANNOT_TELL); the adjudicator sees only the
      routed units, with both answers and notes.
- [ ] The pilot reference locks; the pilot export registers as bundle 7.0; `performance_analysis_v7.py` reads a FORMAL
      bundle only (a PILOT bundle is refused).
- [ ] Registry text that names another trial is shown unchanged (unit SYN7-ROW-CAN_ALL-001).
- [ ] The worked examples show read-only; the acknowledgment records a timestamp and gates nothing.

Scientific gates before the FORMAL freeze (not part of the pilot sign-off): G-PAIN-01, G-MH-V53, G-PROV-01, G-OVERLAP-01, G-TEXT-01, G-EST-01, G-OQ-03, G-OQ-04.
