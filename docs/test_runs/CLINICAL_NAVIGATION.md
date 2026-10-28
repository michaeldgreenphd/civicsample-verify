# Hosted navigation and follow-up labels

The hosted workspace opens Mapping units directly for investigators, reviewers and adjudicators.
The unused Mapping confirmation tab and the Design v7 badge are absent. Worked examples and
the review guide remain available within Mapping units. Local synthetic engineering demos
retain the earlier modules.

Recognized legacy subgroup queue references display the condition and the original inclusion
or exclusion choice in plain language. This translates only the token already present in the
queue; unknown references retain their original text. Packet retrieval, stored identifiers,
clinical assertions, answers and review rules are unchanged. The same labels appear in the
phone selector and the adjudicator queue.

The existing sequencing is explicit: inclusion/exclusion checks open after the reviewer has
answered every primary classification. This is enforced by MU7-G53/MU7-G56 (read) and MU7-G33
(submit), not by the disabled button alone. No migration, frozen guide, sample or stored
packet changed. No remote data was written or reviewer account used for these checks.

## Executed checks

- `VERIFY_ANALYSIS_PYTHON=<existing local analysis interpreter> npm run check`: typecheck and
  lint passed; 420 tests passed, zero failed, 44 skipped and one existing TODO. Fixture and
  v4/v5/v7 leakage scans passed. Skipped native PostgreSQL and configured live-service tests
  do not establish remote acceptance.
- `npm run build`: passed; 44 SQL inputs retained, no local runtime files in production traces.
- `npm run test:e2e:production`: 31 served-browser scenarios passed using fictional fixtures
  and intercepted hosted DTOs. Includes all three hosted roles, preserved view-only and MFA
  boundaries, a four-role synthetic lifecycle, and locked-check labels at 1280, 390 and 320px.
  No locked packet request was made. Save-and-next still unlocks the subsequent checks after
  persistence. The initial run had two outdated/incorrect assertions, both corrected before
  the passing rerun (mobile status text and native option.disabled).
- `npx prettier --check` for all changed TypeScript/CSS files and this note: passed.
- `npm run format:check`: failed on 13 unchanged vendored handoff files. All 13 were compared
  byte-for-byte against the base revision; none was modified or reformatted.
- `git diff --check`: passed.

Synthetic browser evidence is generated at `test-results/followup-checks-desktop.png` and
`test-results/followup-checks-mobile.png` (ignored). The diagram supplied to the investigator
is a separate explanatory artifact, not evidence of a deployed change. Deployment and the
live review database were not modified by this UI work.
