# Local mapping-confirmation walkthrough (synthetic)

Everything in this walkthrough is synthetic: fictional trials, fictional summaries, four synthetic
role accounts. It runs on a **separate** database directory (`.local/pglite-mapconf-demo`) so the
existing pilot database in `.local/pglite` is never touched. The three training examples shown in
the app are synthetic walkthroughs; the real worked examples remain pending their compatibility
decision and are not loaded.

## One-time setup

1. Build the application from the branch under review (the export records the build commit):
   `npm run build`
2. Create the private credentials file outside every repository, for example
   `node scripts/mapconf-demo.mjs setup --credentials "$HOME/Private/civicsample-verify-demo/mapconf-demo.json"`.
   The command prints only the path. The file (mode 600) holds four random passwords for the
   accounts `investigator`, `reviewer-a`, `reviewer-b` and `adjudicator`. Nothing is written to
   `.env.local`, to a tracked file, to a PR or to a log.
3. Start the served app on its own port:
   `node scripts/mapconf-demo.mjs start --credentials "$HOME/Private/civicsample-verify-demo/mapconf-demo.json"`
   URL: **http://127.0.0.1:3200/**

Use one browser profile (or private window) per role, so sessions stay separate. Sign in with
the account name from the "Pilot account" list and the password from the private file. Sign out
before switching roles in the same window.

## Walkthrough

**Role: investigator** (study operator only; it holds no reviewer privileges)

1. Sign in as `investigator`, open the tab **Mapping confirmation**.
2. Click **Create synthetic campaign** (condition set `CONDSET-PPR-FIG2-v5.1-PROPOSED`, status PROPOSED; rubric `MAPPING_CONFIRMATION_RUBRIC-DRAFT-1`).
3. Click **Import synthetic mappings**: 12 synthetic pilot mappings (`MC-SYN-001` … `MC-SYN-012`) and the three synthetic training examples (`MC-TRN-001` … `MC-TRN-003`). The button **Import evaluation mappings** is disabled and the database refuses evaluation records.
4. Click **Assign to the two pilot reviewers**. The completion table shows 12 / 0 for each slot (counts only; the investigator never sees answers while the campaign is open).

**Role: reviewer-a** (slot 1)

5. Sign in as `reviewer-a`, open **Mapping confirmation**. Expand the three **Training examples**: a clear Yes, a disagreement resolved by the adjudicator, and a concordant "Insufficient information" that is reviewed without approval. They are labelled synthetic and never scored.
6. Open `MC-SYN-011` (COVID-19). The **existing assignment** ("Assigned to this condition", source and version), the trial title and the brief summary are shown; no model reasoning or counts. Answer **Yes** and click **Submit final answer**. The answer is final: the form is replaced by your recorded answer.
7. Open `MC-SYN-003`: the brief summary is marked as missing in the source record; nothing was generated in its place.
8. Open `MC-SYN-012` (no summary): answer **Insufficient information**, write an annotation, submit. It is recorded as a _proposed rubric addition_, not an approval.
9. Answer the remaining mappings **Yes** (any annotation optional). Sign out.

**Role: reviewer-b** (slot 2)

10. Sign in as `reviewer-b`. Your queue has the same mappings in a different order and shows none of reviewer-a's answers.
11. Open `MC-SYN-011`: answer **No** (an annotation is required, for example "healthy volunteers without infection"), submit.
12. Open `MC-SYN-012`: answer **Insufficient information** with an annotation, submit.
13. Answer the remaining mappings **Yes**. Sign out.

**Role: adjudicator** (before authorization)

14. Sign in as `adjudicator`, open **Mapping confirmation**: the queue is empty. Both reviewers have submitted, but the campaign is still open and adjudication is not authorized, so nothing is readable yet.

**Role: investigator**

15. Sign in as `investigator`. The completion table shows 12 / 12 for both slots. Type an attestation (twenty characters or more) and click **Close submissions**, then type it again and click **Authorize adjudication**.
16. Try **Lock the campaign** now: it is refused, because `MC-SYN-011` (disagreement) and `MC-SYN-012` (both insufficient) have no adjudication.

**Role: adjudicator**

17. Sign in as `adjudicator`. The queue lists all 12 complete mappings; `MC-SYN-011` and `MC-SYN-012` are marked **Needs adjudication**, the others **Concordant** (not adjudicable).
18. Open `MC-SYN-011`: both final answers and annotations are visible. Status _Discordant resolved_, decision **No**, basis **Reviewer 2**, rationale; click **Record adjudication**. (A basis that does not match the reviewer who gave that answer is refused by the database.)
19. Open `MC-SYN-012`: the form starts empty and offers **Rubric addition reviewed** with no Yes/No decision. Write the rationale and record it. The proposed rubric addition is now reviewed, not approved.

**Role: investigator**

20. Sign in as `investigator`, type the attestation, click **Lock the campaign**.
21. Click **Build export**: the manifest shows `MAPPING_CONFIRMATION`, `EXISTING_ASSIGNMENT_VISIBLE`, `is_synthetic_fixture: true`, `weights_or_probabilities: NONE`, `analysis_specification: PENDING`. Download `mapping_confirmation_cases.csv`, `mapping_confirmation_responses.csv` and the manifest. Training examples are absent from the export. Click **Register export**.

## Stopping and resetting

Stop the server with Ctrl-C. To start the demonstration again from scratch, delete the directory
`.local/pglite-mapconf-demo` only (never `.local/pglite`) and run `start` again. To rotate the demo
passwords, delete the private credentials file and run `setup` again.
