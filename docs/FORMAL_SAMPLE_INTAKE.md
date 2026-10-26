# Preparing the 100 mappings

This increment makes the investigator's real-data intake concrete without opening clinical review. Migration 0039 adds one transactional RPC and an immutable receipt. Earlier migrations and scientific guards are unchanged.

## Prepare privately

From a clean, reviewed checkout, run:

```sh
npm run mu81:prepare-intake -- /absolute/private/verified-package /absolute/private/new-intake ONE_PER_TRIAL
```

The source must be outside every Git repository, with its private checksum manifest. The tool verifies the guide preparation, all existing sample invariants, the database-computed packet hashes and the probability binding. It then rehearses the exact intake RPC in a second disposable database. Neither database is the app database and no network request is made. Only counts and status reach standard output; errors suppress private values.

The new output directory contains owner-only `formal-intake.json`, `intake.env` and `SHA256SUMS.txt`. The package names the source commit and original import digest. Preserve these files privately. They do not belong in the public repository, build context, browser assets, issue comments or a public CI artifact.

## Connect an empty destination

The application currently stores one mapping-unit design per database. A practice database with an existing design cannot be reused by this intake. Do not reset it or delete records. Select a separate empty destination, review its migration/account plan and obtain explicit authorization before making remote changes. The privileged bootstrap tool's project allowlist is a separate control and is not widened by this change.

Apply the reviewed lineage through 0039 with the administrative migration tool, separately from the web app. The web app continues to use a publishable key and the signed-in user's token, never a service-role key or database password. The investigator must have a verified second factor. Read-only practice observers cannot use this route.

Configure `VERIFY_FORMAL_INTAKE_FILE` as the absolute, resolved path of the private JSON file and `VERIFY_FORMAL_INTAKE_SHA256` as its file checksum on the server performing intake. Both are server-only settings. The file must be a regular file outside Git with owner-only permissions; symlinks, changed bytes and oversized files are refused. A local instance connected to the authorized Supabase destination can perform this preparation, so the private source file need not be uploaded to the public web host. A clean build is still required for the subsequently deployed clinician app.

In **Mapping units → Connect the prepared sample**, check the package and destination, enter the explicit preparation attestation and load the mappings. The browser sends only the checksum and attestation. Evidence stays on the server-to-database path. The server calls the database as the investigator.

## What loading does

- Records exactly 100 FORMAL mappings: 56 therapeutic-area, 40 condition-row and four subgroup units.
- Verifies 100 distinct trials for ONE_PER_TRIAL, both complete 100-position queue plans and the database's actual unit, assignment, design-row and packet-inventory digests.
- Preserves nominal selection probabilities and binds the separate Monte Carlo probabilities for ONE_PER_TRIAL; this does not approve an estimator.
- Binds the reviewed guide and records an immutable preparation receipt.
- Commits everything together or nothing. Retrying the identical package verifies its receipt and current formal inventory without duplicating rows. A different package is refused. Intake closes after freeze or formal opening.

The queue plan is checked and hashed, but **no queue is assigned**. No reviewer is enrolled, no phase is opened, no gate is approved and no judgment is written. Reviewers and the adjudicator cannot retrieve the unassigned units. Errors returned to the browser omit database diagnostics and evidence.

After intake succeeds, the preparation summary refreshes to show the recorded count and the investigator's tab becomes **Study preparation**. Synthetic pilot controls are shown only for practice designs. If that status refresh fails, the success message still confirms the completed intake and asks for a page refresh. A failed status refresh does not undo a successful import.

## Before clinicians receive actual cases

The remaining work is explicit: approve the outstanding study requirements as investigator actions; verify the required pilot sign-off; freeze and verify the selected manifest; assign the two reviewers to the same frozen 100-unit queue; and open the formal phase. Those actions need separate implementation/release verification and authorization. They cannot be inferred from a successful intake or AI results.

Run live JWT, RLS, account-lock, reviewer-isolation, export and backup/restore acceptance on the intended destination and exact deployment build. The current intake tests use synthetic data and disposable databases; a local test is not a Supabase acceptance result. Keep the current practice deployment available while preparing the formal destination.
