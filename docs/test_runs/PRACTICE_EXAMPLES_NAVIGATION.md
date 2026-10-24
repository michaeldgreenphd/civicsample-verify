# Practice navigation and worked examples — 2026-10-24

The practice workspace has separate tabs for work and read-only worked examples. Switching tabs keeps an unfinished reviewer answer and adjudicator form mounted; it neither saves nor resets them. Acknowledgment failures remain visible on the examples tab. The same navigation supports the investigator and the view-only practice account.

The desktop layout places example evidence beside its illustrative answers and outcome. Phones use stacked evidence and a compact case selector, with unavailable subgroup options disabled. Progress counts saved answers only. The legacy campaign's status badge is omitted from the mapping-unit workspace because it describes a different campaign.

## Scope and compatibility

- Based on published practice commit `6300cf9f1dda0bdec3c65f688c0dfcdf4d8910b5`, on a separate UI branch/worktree.
- No migration, rubric, packet content, worked-example content, scientific gate, sample or export change.
- Investigator and adjudicator workspace DTOs add the existing allowlisted `training` projection. It reads the existing training table under the caller's row-level security; no permissions change. Local and REST-adapter tests confirm three illustrations are available while the actual adjudication queue is empty.
- The new navigation is explicitly for the current synthetic practice deployment. Formal review remains disabled; this is not formal-release readiness evidence.
- No live project, account, operational record or deployment was changed.

## Executed verification

| Command/check                                                                              | Observed result                                                                                                                                                     |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check` with `VERIFY_ANALYSIS_PYTHON` pointing to the existing analysis virtualenv | PASS: typecheck, lint, 231 tests passed, 0 failed, 30 skipped, 1 existing TODO; fixture and v4/v5/v7 leakage scans report zero violations                           |
| `npm run build`                                                                            | PASS: production build and trace scan, 33 SQL inputs, no local runtime files                                                                                        |
| `npm run test:e2e:production`                                                              | PASS: 9 served-browser scenarios, including independent roles, save/reload/revision, adjudication, account lock/release and export integrity                        |
| `npm run typecheck` and `npm run lint` after layout refinements                            | PASS                                                                                                                                                                |
| Prettier check of all changed source and test files                                        | PASS                                                                                                                                                                |
| `npm run format:check`                                                                     | FAIL on 15 pre-existing handoff/design/script files, all verified byte-identical to the base commit; preserved rather than rewriting supplied or scientific content |
| `git diff --check`                                                                         | PASS                                                                                                                                                                |
| Native PostgreSQL and live Supabase tests                                                  | BLOCKED locally: not configured; no shared staging requests made                                                                                                    |

The new browser assertions cover tab arrow/Home navigation and focus, all three example selectors, no POST while consulting examples, preservation of answer/reason/note/uncertainty, acknowledgment failure/retry, mobile saving, case selection and disabled subgroup options. Automated axe WCAG 2 A/AA checks report no violations on the desktop examples and mobile answer view. Reflow checks pass at 320 and 640 CSS pixels; screenshots were visually inspected at 390 and 1440 pixels. This is not a complete accessibility certification or a physical-device test.

The first browser attempt was blocked by the local listener permission; it was rerun with that permission. The first executed scenario exposed a test-matcher limitation: `toBeDisabled()` reported an `<option disabled>` as enabled. The test now asserts the native `disabled` property; the application restriction was retained.

## Screenshot evidence

The browser suite generates these synthetic-only files in ignored `test-results/`:

- `mu7-hosted-examples-desktop.png`
- `mu7-hosted-examples-mobile.png`
- `mu7-hosted-practice-desktop.png`
- `mu7-hosted-practice-mobile.png`

These show hosted navigation using an explicitly mocked session environment flag with authenticated local synthetic data. They do not claim a live Supabase test. Other browser scenarios continue to exercise actual local authorization and denial paths.

## Release

Review and merge through the practice branch before deployment. Coordinate the UI files with any concurrent scientific integration; preserve the rubric and example content from its separately approved source. Do not infer approval of pending scientific gates from this UI change.

## Presentation follow-up — 2026-10-24

Reason identifiers now display in sentence case (preserving the spelling MeSH), with the existing definition below the selector. Saved-answer summaries, human answers on the adjudicator screen, and worked-example illustrations use the same presentation. Option values and submitted/stored/exported codes remain canonical; the browser regression verifies the saved code directly through the authenticated API.

The synthetic notices use plain, muted text instead of yellow badges. The mapping summary uses a heading, secondary MeSH context and a thin separator instead of a tinted box and accent bar. This changes presentation only: the packet object and its hashes are untouched, and the exclusion notice remains visible. Source registry text is not reformatted.

Rechecked the production build, nine browser scenarios, keyboard/reflow and axe checks, changed-file formatting and whitespace. Updated synthetic desktop and mobile screenshots are in the same ignored paths listed above.
