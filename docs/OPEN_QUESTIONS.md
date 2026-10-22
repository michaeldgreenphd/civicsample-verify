# Decisions and integration work still open

The latest direct decisions are in [REVIEW_WORKFLOW_DECISIONS.md](REVIEW_WORKFLOW_DECISIONS.md): 100 individual trial-to-condition mappings, three excluded training examples, and visible existing assignments. This is a mapping-confirmation review; the proposed v5 100-trial workflow is not the requested final design. Prior open questions below are historical context where superseded.

## Investigator decisions

The investigator has selected the staging roster and disagreements-only adjudication scope, and requested three shared calibration examples before independent review. Account identities remain private; no staging accounts exist yet. Tier 1 selection remains explicitly AWAITING APPROVAL. No decision is inferred from a successful software test.

The Tier 1 version (`v1.1` versus `v1.2`), proposed 100-case formal sample adequacy and inference target, rubric, analysis plan, and handling of indeterminate judgments remain pending verification of explicit approval. The weak coverage of Tier 0-negative/Tier 1-positive cases remains a blocking warning. Synthetic fixture counts and invented strata do not establish the formal sample's size, coverage, or scientific adequacy. Hosting region, retention, and Module B scope require their own decisions. No application action substitutes for these approvals.

## Direct request takes precedence over attached source

The latest user request requires locked final submissions and explicit audited amendments; the supplied handoff permits ordinary revisions until close. The application follows the stricter request. It requires rationale for every final decision, although the attached contract treats some rationale as recommended. It requires two completed independent reviewers before adjudication; the supplied formal path also describes single-review adjudication. These distinctions are enforced by the synthetic extension. Formal integration must reconcile them through additive changes before exposure to clinician accounts.

The handoff recommends a Python frontend; the user prefers Next.js. This build uses Next.js and TypeScript with the supplied PostgreSQL lineage and separate Python analysis. Clinical rules and proposed analysis methods are not approved merely because synthetic tests pass.

## Remaining engineering work

- Complete the local pilot using separate role passwords and browser profiles on the same computer. See [LOCAL_PILOT.md](LOCAL_PILOT.md). Record interface findings and acceptance without changing formal approval states.
- Replace synthetic invitation/JWT scaffolding with a verified external identity provider in an authorized isolated Supabase staging project. Actual TOTP/MFA, invited enrollment, token refresh, and deployed PostgREST/JWT boundaries remain incomplete.
- Extend case authoring and evidence preview to multi-project/campaign administration. Formal rubric/version registration, private sample import, freeze, and clinical lifecycle screens remain incomplete; `formalActivationAllowed` stays false.
- Preserve the synthetic database-to-CSV-to-Python export integration while adding the eventual deployed formal boundary. The adapter requires the actual nonzero export build SHA and checks ontology/rubric hashes against the registered frozen case versions. It still refuses real study data.
- Inspect current-head native PostgreSQL CI results and run separate Supabase table/view/RPC access tests. The PostgreSQL harness uses `pg` and disposable `verify_disp_...` databases, leaving the database supplied through `VERIFY_PG_TEST_URL` unchanged. Use the startup preflight with pending 0008/0009 upgrades; never reset incompatible frozen data to bypass refusal.
- Complete manual screen-reader/keyboard and mobile usability review, load/latency measurements, backup restoration, and operational logging/retention checks. GitHub Pages cannot run this server application; future hosting requires a separately approved Next.js and Supabase deployment.

Module B remains separate and unapproved, with no active application review workflow. Adjudication forms retain unsent edits only in the current view and disclose that limitation. See [READINESS_REPORT.md](../READINESS_REPORT.md) for actual verification results rather than inferring readiness from this work list.

## Design v5 (handoff v5 / v5.1, 2026-10-22): items for the investigator

- **Migration numbering:** the supplied v5 migrations are committed byte-identical as `migrations/0011_v5_trial_label_verification.sql` and `migrations/0012_v5_training_examples.sql` because this repository already holds additive migrations 0004 to 0010. The supplied PGlite suites pass on both the package's lineage and this repository's full lineage; the only differing step is the schema-version list (`V5-SCHEMA-01`, like the documented `V4-SCHEMA-01`). The v3 and v4 suites cannot run on the full lineage because migration 0010 refuses investigator pilot adjudications; they run on the package lineage with 0011/0012 added. Confirm that this numbering is acceptable for the production migration order.
- **Pilot adjudication by an investigator:** the supplied schema allows it, but the standing direct instruction forbids it. Additive 0013 closes that path at the database boundary; this requires explicit investigator reconciliation before any future change.
- **Revisions until the close:** the supplied v5 protocol proposes ordinary revisions. The hardened app retains locked final submissions under the standing instruction. A distinct authorized amendment process is not yet implemented for v5; any change requires explicit approval.
- **Packet fields:** v5.1 shows the NCT identifier as text and omits the registry link, study type, primary purpose, phase, keywords and primary outcome titles that the private scientific contract (6.3) lists; the contract revision is an investigator item (`docs/design_v5/REVIEW_RUBRIC_v5_1.md`, section 14).
- **Rubric decisions (section 2 of the rubric):** construct, adjudication scope (the app records whatever scope the investigator activates), subgroup display rule, calibration, whether the training view shows the adjudicated outcome of example 3 (`VERIFY_TLV5_HIDE_TRAINING_OUTCOME=1` hides it), and the rubric text itself. The embedded rubric (`src/lib/tlv5-codes.ts`, `REVIEW_RUBRIC_v5_1-DRAFT`) is hashed into every export manifest and must be replaced by the frozen text before the freeze.
- **ERRATA_v5_1 item 1:** 0012 no longer refuses an NCT identifier inside registry text values; the investigator may ask for a new additive migration that restores a value check for identifiers other than `trial.nct_id`.
- **Supplied analysis under pandas 3:** `analysis/performance_analysis_v5.py` treats a NaN rule label or subgroup answer as absent in `estimand_vectors`, because the package's test `test_rule_mappings` fails unmodified under the pinned pandas 3.0.6; no statistic changes. The package authors may want the same fix upstream.
- **Formal and training imports:** the historical author used `scripts/tlv5-staging-dryrun.ts` with private files on a disposable database. That script now refuses before reading private files pending the revised mapping-unit protocol. The historical dry run used placeholder registry text for the sample and calibration trials (the transfer files carry no registry fields); the investigator's production import must build packets from the registry fields, as `APP_MAPPING_v5_1.md` section 5 requires.
- **Live platforms:** no PostgreSQL or Docker binary exists on this machine and Supabase staging exists but is not configured for this application, so native PostgreSQL results rely on the CI job and Supabase acceptance stays UNTESTED.

## Contract reconciliation before staging activation

- **Open-phase investigator access:** the latest roster request describes access to judgments and predictions; contract section 9.3 permits completion counts only while review is open. Preserve the counts-only restriction until the investigator specifies the phase boundary.
- **Revisions:** contract section 7.5 permits append-only revisions until close; the earlier direct request and local application require deliberate final submission and an authorized amendment. Preserve finality rather than silently broaden writes.
- **Pilot analysis:** SYN pilot records remain excluded. Contract sections 1 and 16 prohibit using them for performance statistics. The separate HO4-TESTFX synthetic formal-shaped bundle exercises analysis; it does not establish clinical validity.
- **Development import before activation:** the preserved 0003 guard requires design activation before development-registry insertion. The current instruction prohibits activation. Read-only preflight can proceed; database insertion cannot.
- **Strict role separation:** the requested investigator role must never write judgments. Additive migration 0010 now rejects new investigator adjudications and spoofed deciders in both historical adjudication tables. Existing historical rows remain untouched; the local pilot already uses a separate adjudicator. Real JWT negative tests are still required.
- **Single-review adjudication:** the historical formal contract describes it, but the application requires both independent submissions. Retain the two-submission requirement pending reconciliation.
- **Not-applicable export representation:** contract section 7.4 describes NOT_APPLICABLE, while section 13.2 specifies empty CSV for SQL NULL. Do not silently change format 4.0 or conflate unanswered and inapplicable fields.
- **Three shared examples:** identities and evidence are awaited. Register them as calibration/development and exclude their frame units from the independent sample before freeze. Any resulting sample replacement needs investigator approval.
- **Live access:** a handoff folder is not a Supabase project configuration. The staging project exists. Its private configuration, real identity sessions and authorized bootstrap are not yet connected. The investigator prefers individual usernames without reviewer email addresses and administrator-managed resets; the earlier email-based planning tool is not that implementation. Module B reviewer qualifications and benchmark-definition permission remain open.

A v5 handoff is source material, not evidence by itself of approval to replace the held-out design. In particular its inclusion of development-linked trials and revised inference targets require an investigator approval record. The public app keeps formal controls blocked.

The private source contract and its status table are not reproduced here. The roster decision does not approve Tier 1, import a proposed sample, activate design v4, or authorize invitations.
