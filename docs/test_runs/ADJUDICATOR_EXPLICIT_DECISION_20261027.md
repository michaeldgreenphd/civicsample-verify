# Deliberate adjudication and safe case navigation

The adjudicator form previously opened with Agree and Reviewer 1 selected, including when
Reviewer 1 had answered Cannot tell. It now requires an explicit answer and offers only a
reviewer whose answer matches that decision, or Neither. Disagree requires a valid reason.
The existing database validation remains authoritative.

A late case response is discarded after navigation. Navigation and duplicate submission are
disabled while an adjudication is being saved, so its response cannot replace another case's
form. Selecting another case starts with an empty decision, reason and rationale.

## Verification

- `VERIFY_ANALYSIS_PYTHON=<existing-analysis-python> npm run check`: 408 passed, 0 failed,
  39 skipped, 1 existing todo. The skipped native PostgreSQL and live-staging checks remain
  BLOCKED locally. Fixture and leakage scans are included in this command.
- `npm run build`: passed; 41 SQL inputs, no local runtime files in traced output.
- `npm run test:e2e:production`: 25 passed. The two new served-browser tests cover explicit
  choice, compatible bases, Disagree validation, per-case reset, navigation during a delayed
  save, and a delayed obsolete case response. They mock only the v7 data API with fictional
  packets; the existing suite also runs the synthetic database lifecycle and exports.
- Prettier on the changed source and test: passed. `git diff --check`: passed.
- Repository-wide `npm run format:check`: fails on 13 unchanged supplied v7 files. They were
  not reformatted in this focused change.

The first check invocation used a Python environment missing NumPy and pandas. Its ten
analysis failures were not counted as passes; the complete command was rerun with the
existing analysis environment. The initial new browser checks used exact implicit-label
selectors that included selected option/text content; they were corrected to accessible
role/name selectors and rerun.

No schema, scientific gate, sample, remote database, password or deployment changed. This
change does not implement individual reviewer completion or the subsequently requested
adjudication of two Cannot tell answers. Those require a separate versioned protocol,
database, guide and export change before formal review can open.
