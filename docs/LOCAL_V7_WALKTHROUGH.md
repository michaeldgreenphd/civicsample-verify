# Local walkthrough, review design v7 (synthetic)

Everything here is synthetic: the 12 pilot units of `tests/handoff/fixtures/v7/SYNTHETIC_PILOT_UNITS_v7.json`, three synthetic worked examples, and four synthetic role accounts. It runs on its own database folder (`.local/pglite-v7-walkthrough`), so the pilot database (`.local/pglite`) and the mapping-confirmation demo (`.local/pglite-mapconf-demo`) are never touched. The formal review is not offered: the FORMAL freeze and opening wait for the study decisions (migration 0026), and nothing in this walkthrough specifies or approves one.

## Start

1. Build from the branch under review (the export records the build commit, so build from a clean tree): `npm run build`
2. Create the private credentials file once, outside every repository. The command prints only the path; the file (mode 600) holds four random passwords:
   `node scripts/mapconf-demo.mjs setup --credentials "$HOME/Private/civicsample-verify-demo/v7-walkthrough.json"`
3. Start the served app:
   `node scripts/mapconf-demo.mjs start --credentials "$HOME/Private/civicsample-verify-demo/v7-walkthrough.json" --database .local/pglite-v7-walkthrough --port 3300`
   URL: **http://127.0.0.1:3300/**, tab **Mapping units**.

Use one browser profile or private window per role. Sign in with the account name from the "Pilot account" list and its password from the private file.

## Walkthrough

**Investigator**

1. Write an attestation (one sentence, 20 characters or more) and click **Record the synthetic design** (`SYN-7-LOCAL-WALKTHROUGH`).
2. **Import the synthetic pilot units** (12), **Import the worked examples** (3, read only), **Assign both pilot queues** (reviewer-a is slot 1, reviewer-b slot 2; primary units first, subgroup units last).
3. Try **Lock the pilot reference** now: the database refuses it with its own message (MU7-G48), because nothing is answered yet.

**Reviewer A and Reviewer B**, each in their own window

4. Open **Worked examples** and read EX7-01 to EX7-03; **Mark the worked examples as read** records a timestamp and gates nothing.
5. Subgroup units show as "Opens later" until all 8 primary units are answered.
6. On a unit, the mapping label, our assignment and, for the Mental health unit, the study-rule note are shown as stored. Answer **Agree**, **Disagree** or **Cannot tell**. A Disagree without a note is refused with the guard message (MU7-G36); a reason code that does not fit is refused (MU7-G35).
7. Reload the page and reopen the unit: your answer is on record and the form starts from it. Saving again is a revision; the first answer is kept.
8. `SYN7-ROW-CAN_ALL-001` shows registry text that names another trial, unchanged.
9. The planted answers of the walkthrough are in `units[i].walkthrough.planted_answers` of the synthetic file (slot 1 is reviewer-a). They route 5 units to the adjudicator and 1 to "both cannot tell".

**Adjudicator**

10. Only the 5 routed units appear, with both answers, reason codes, notes and uncertainty. Resolve each (Agree or Disagree and the reviewer adopted) or mark it unresolved. A reviewer can no longer change a unit after its tie-break (MU7X-G01).

**Investigator**

11. The **Synthetic routing check** compares each unit's routing with the walkthrough's expectation. It is a check of the synthetic pilot, not a result.
12. **Account lock (local only)**: lock and release an account to see a locked account refused at once. On Supabase this is the privileged identity tool's job, never the application's.
13. **Lock the pilot reference** (attestation). Nothing can be added or answered afterwards.
14. **Build export**, open `manifest.json` and the four CSV files (bundle 7.0, marked `SYNTHETIC PILOT: excluded from every statistic`), then **Register export**. The analysis (`analysis/v7/performance_analysis_v7.py`) refuses a PILOT bundle by design.
15. **Study decisions before the formal review** lists every gate as pending specification; the formal review stays disabled.

To start over, stop the server and delete the folder `.local/pglite-v7-walkthrough`.
