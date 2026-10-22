# Local synthetic pilot walkthrough

This phase tests the interface and engineering controls on fictional cases. It is not clinical validation, formal sample approval, or an invitation to physicians. Keep the forthcoming investigator approval record separate from this public repository; its contents must be checked before scientific gates can change.

## Prepare the local accounts

In the repository terminal:

```sh
npm ci
npm run setup -- --individual-credentials
npm run dev -- --port 3001
```

Use the address printed by the server, normally http://127.0.0.1:3001 for this command. Open `.local/pilot-access.txt` privately to retrieve the four role passwords. Setup adds missing role credentials while preserving existing settings, passwords, and database records. Existing local pilots using the legacy shared password switch to role passwords after setup and a server restart. Once any role password is configured, an unconfigured role cannot fall back to the shared password.

The access sheet and `.env.local` are ignored private files. Keep investigator and adjudicator credentials with the investigator; give a tester only the credential for their assigned synthetic role. Do not include credentials, access-sheet screenshots, or reviewer responses in GitHub issues or pull requests.

Use a separate browser profile for each role on the **same computer** that runs the application. Tabs in one profile share a login cookie and are not independent accounts. This localhost pilot does not support remote reviewers, a public tunnel, or shared hosting. Role passwords support local testing; they are not verified clinician identities or MFA.

## Work through the pilot

1. Sign in as `investigator`. Confirm that the campaign is synthetic and formal gates are blocked. Review the rubric and pending version proposal. A proposal is not an approval.
2. Optionally author another fictional case while the campaign is open. Edit every relevant descriptor and trial field, then check the complete evidence preview before saving. The saved case is assigned to both reviewers. Never paste real registry evidence or held-out IDs into this form.
3. In separate profiles, sign in as `reviewer-a` and `reviewer-b`. Each reviewer independently completes the same cases. Save a draft, navigate away, and return to confirm persistence. Submit a rationale and uncertainty with each final response; use structured context when required.
4. For a two-step trial case, complete and lock the descriptor judgment before viewing trial context. The initial judgment cannot be reopened after context is disclosed. Verify that neither reviewer can see the other's response or classifier predictions.
5. After both reviewers finish every assigned case, use the investigator session to close independent review and explicitly authorize adjudication. Do not close early merely to advance the interface.
6. Sign in as `adjudicator`. Review the authorized human judgments and record a separate reasoned determination at each required level. This is adjudication, not a third independent review.
7. Return to `investigator`, lock the completed reference, and download the synthetic pilot audit archive. Repeated downloads from an unchanged locked campaign should match. The archive has `analysis_eligible: false` and contains no clinical performance statistics.

Final submissions are immutable. Any permitted amendment needs explicit investigator authorization and preserves the original record. A locked campaign cannot be reopened through ordinary editing. If a second pilot campaign is needed, keep the original data and exports and arrange an explicit separate synthetic test environment; do not delete the database to start over.

## Proposed v5 pilot (trial verification tab)

This synthetic engineering workflow is not the newly requested 100-mapping confirmation review. Its formal web actions and private-file dry run remain blocked.

The "Trial verification" tab runs the design v5 synthetic pilot with the same four accounts (the two reviewer accounts are the pilot test accounts). As `investigator`: import the 10 synthetic pilot trials, then assign them to both pilot accounts. As `reviewer-a` and `reviewer-b`, in separate profiles: open each trial, answer the 7 area items and the 10 condition-row items; the diabetes-type and malignancy items appear only while your own row answer is Yes and disappear when you change it. Follow the pilot script in `docs/design_v5/SYNTHETIC_PILOT_CASES_v5.csv` (account 2 plants two disagreements and one packet-problem flag; the old revision example must be completed before final submission because ordinary final revisions are now refused). As `adjudicator`: the queue lists trials after both independent reviewers submit; resolve the planted disagreements with a status, basis, reason code and rationale (a concordant item is refused under the disagreements-only scope). As `investigator`: lock the pilot reference, preview the bundle, download the four files, register the export, then run

```sh
.venv/bin/python -m analysis.performance_analysis_v5 --manifest <folder>/pilot_bundle_v5.manifest.json --out <new folder> --allow-pilot
```

and sign off the pilot with the SHA-256 of your signed checklist. Activation, formal enrolment, freeze and formal assignment through the web app remain blocked pending an approved design; `staging-reviewer-1` and `staging-reviewer-2` are synthetic FORMAL-scope identities for training examples and dry runs only.

## Record useful feedback

Record the synthetic case ID, role, action, expected behavior, and observed behavior. Check keyboard access, visible focus, narrow-screen layout, draft status, errors, evidence readability, and whether the preview matches the reviewer packet. Keep actual responses and exported audit records private. A sanitized issue may describe a reproducible software defect without including credentials or response text.

The investigator's acceptance record should distinguish interface findings, unresolved scientific choices, and authorization for later work. Completing this checklist does not freeze the formal sample or activate clinical review. See [approval gates](APPROVAL_GATES.md) and [readiness status](../READINESS_REPORT.md).

## Persistence and upgrade refusals

The local database is stored in ignored `.local/pglite`; stopping the server preserves records. Restarting applies pending additive upgrades and checks frozen-contract compatibility without rewriting judgments. If startup reports an incompatible frozen trial contract or a protected formal reference, preserve the directory and existing exports for explicit investigator migration review. Never bypass that refusal by resetting, deleting, or relabeling study records.
