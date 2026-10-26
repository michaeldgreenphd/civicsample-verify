# Save and next: reviewer navigation and spacing

The Mapping units reviewer can save an answer and continue to the next available unanswered case. The next case is chosen from the refreshed server queue, including inclusion/exclusion checks that become available after the final primary answer. Save answer / Save revision remains available when the reviewer wants to stay on the case. Completion leaves the final case open and confirms that all answers are saved.

A failed submission retains the draft. A confirmed submission followed by a failed progress read offers a read-only retry rather than resubmitting the answer. A failed next-case read also has its own retry. Controls are disabled during saving, repeated clicks are guarded, and cancelled case reads cannot overwrite a later selection. Keyboard focus moves to the newly loaded trial title. No answer is preselected on a new case.

The answer controls use consistent vertical spacing. Actions are at least 48 pixels high, separated by 12 pixels, and stack on narrow screens. Helper text remains beneath the buttons and inside the panel. The investigator preview also separates its read-only notice from the review target.

## Executed verification

Final application/test commit: `d4a9ef9`.

- `VERIFY_ANALYSIS_PYTHON=<existing analysis virtualenv>/bin/python npm run check`: 408 passed, 0 failed, 39 skipped, 1 existing TODO. Typecheck, lint, fixture scan and v4/v5/v7 leakage scans passed. This full run covered the navigation implementation; subsequent button-spacing and completion-copy changes were checked again with targeted typecheck/lint, formatting, commit-hook scans, the production build and the full browser suite.
- `node --import tsx --test tests/mu7-review-navigation.test.ts`: 4 passed. Covers queue ordering, unavailable/answered cases, wrapping to earlier unanswered cases, newly unlocked checks and completion.
- `npm run build`: passed from the clean final application checkout; production trace scan retained 41 allowed SQL inputs and 7 manifests, with no local runtime files.
- `npm run test:e2e:production`: 23 passed (40.3 seconds) on the final application commit. The synthetic database lifecycle uses Save and next and verifies the recorded response. Four additional browser scenarios exercise delayed saves, double activation, failed saves, progress-only retries, next-case loading errors, stale reads, newly available checks and completion. Existing subtype persistence, role isolation, adjudication and export scenarios also passed.
- Browser layout checks at 1280, 390 and 320 pixels verify button size/separation, helper-text placement and absence of horizontal page overflow. Desktop and phone screenshots were visually inspected. The automated accessibility scan found no violations in the tested state; this is not a complete accessibility certification.
- Targeted `prettier --check` and `git diff --check`: passed.

The first browser pass exposed a button-size override and assertions expecting the old save message or an unscoped alert. After those were corrected, visual inspection found helper text wrapping beside the mobile buttons. A single-column mobile layout and an explicit helper-position check corrected that; the final full browser run above passed.

Native PostgreSQL and live-service checks remain unavailable/skipped locally, not passed. This change adds no database migration or API payload fields. It does not change clinical wording, the rubric, assignment contents, role permissions, approvals or clinical phase state. Browser evidence uses disposable synthetic records and intercepted synthetic failure responses, not operational reviewer records.

## Synthetic screenshots

[Desktop answer panel](../screenshots/reviewer-save-next-desktop.png) · [Phone answer panel](../screenshots/reviewer-save-next-mobile.png)
