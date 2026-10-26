# The named assignment beside each answer

The reviewer answer panel, investigator preview and adjudication form now repeat the review target immediately before the choices. Area and condition-group cues explicitly distinguish the two judgments. Revised inclusion/exclusion profiles retain their polarity: Agree confirms the displayed inclusion or exclusion. Historical subgroup profiles retain their original, potentially narrower assertion.

This presentation-only change adds no questions, clicks or required fields. It does not change the guide, response payloads, packets, preview/AI serialization, stored hashes, database policies or approval gates. A screen-reader description connects the target to the answer choices.

## Executed checks

Application/test commit: `e1aed34`.

- `VERIFY_ANALYSIS_PYTHON=<existing analysis virtualenv>/bin/python npm run check`: 404 passed, 0 failed, 39 skipped, 1 existing TODO. Typecheck, lint, fixture scan and v4/v5/v7 leakage scans passed. Unavailable native PostgreSQL and live-service checks remain skipped, not accepted as passing.
- `node --import tsx --test tests/mu7-display.test.ts`: 7 passed. Checks distinguish area from condition-group judgments, preserve inclusion/exclusion polarity and retain historical assertions.
- `npm run build`: passed from a clean isolated checkout; 41 allowed SQL inputs, 7 manifests and no local runtime files in production traces.
- `npm run test:e2e:production`: 19 passed. Reviewer and preview coverage verifies named targets, one three-choice classification question, correct target changes between units, screen-reader descriptions and no horizontal overflow at 1280, 390 and 320 pixels. Existing save/reload, adjudication, subtype, role isolation and accessibility scenarios passed.
- Targeted `prettier --check` on the changed source, styles and tests: passed.
- `git diff --check`: passed.

Synthetic reviewer and preview screenshots were visually inspected at desktop and mobile sizes. Browser tests use disposable synthetic records; this is not a live clinical acceptance run. No remote schema, accounts, study records, approvals or deployment changed.
