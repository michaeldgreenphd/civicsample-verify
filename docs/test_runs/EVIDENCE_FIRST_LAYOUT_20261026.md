# Trial evidence before the classification

The shared mapping-unit packet now presents the trial title and brief summary before the classification question. Additional registry evidence remains available. Area and condition-row packets omit the repeated membership statement and generic sorting explanation; their classification, parent-category context and specific policy notes remain visible. Subgroup packets retain their distinct inclusion/exclusion assertions, decisions, explanation and answer polarity.

This is a rendering change shared by investigator previews, reviewer and adjudicator screens, and worked examples. Packet data, preview/AI serialization, stored hashes, the reviewer guide, answer vocabulary, database policies and scientific gates are unchanged.

## Executed checks

- `VERIFY_ANALYSIS_PYTHON=<existing analysis virtualenv>/bin/python npm run check`: 401 passed, 0 failed, 39 skipped, 1 existing TODO. Typecheck, lint, fixture scanning and leakage scans passed. Unavailable native PostgreSQL and live-service tests remain skipped, not accepted as passing.
- `npm run build`: passed from a clean isolated checkout at `d275077`; 41 allowed SQL inputs, 7 manifests and no local runtime files in production traces.
- `npm run test:e2e:production`: 18 passed. The preview regression checks evidence-before-classification order at 1280, 390 and 320 pixels, absence of repeated area/row text, retained specific policy notes and subgroup decisions, expandable evidence, no horizontal overflow and no review writes. Existing role, save-answer, subtype and accessibility checks passed.
- Targeted `prettier --check` on the changed source, styles and tests: passed.
- `git diff --check`: passed.

Synthetic desktop and mobile screenshots were visually inspected. These browser checks use synthetic fixtures and disposable local state; they are not a clinical release or a live-service acceptance run. The public practice deployment was not changed.
