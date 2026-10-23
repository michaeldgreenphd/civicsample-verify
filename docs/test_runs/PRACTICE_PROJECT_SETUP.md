# Synthetic practice setup — 2026-10-23

The investigator explicitly authorized the prepared new-project schema plan and
five separate practice accounts. The completed pilot project was not modified.
No invitation was sent, no formal data imported, and no scientific gate approved.

## Applied and independently checked

- Approved schema plan: 30 versioned SQL inputs applied plus one repeatable
  preflight, through the existing guarded runner with verified database TLS.
- Five Auth accounts created and linked to their distinct application roles.
  Generated passwords were saved before account creation in an owner-only file.
- All five accounts signed in successfully with real Supabase Auth credentials;
  own-user visibility and investigator-only gate refusal at aal1 passed.
- The investigator enrolled MFA and initialized the synthetic design, examples,
  units and queues through the protected app.
- Read-only database verification: 12 PILOT units, three training examples,
  24 assignments (12 per reviewer), zero judgments, zero gate approvals,
  zero locked references.
- Local served application against the actual new Supabase project: all five
  sign-ins passed; both reviewers received their own 12 units and three examples;
  the adjudicator had no routed answers; each reviewer was refused the other's
  assignment (404); a wrong password was refused (401). Investigator actions at
  aal1 required MFA. No practice answers were written by these checks.

## Name selector

The optional runtime setting exposes only explicitly public username/label pairs.
It does not query the private roster or supply permissions. Individual passwords,
MFA and database authorization are unchanged. Tests reject extra password/role/ID
fields, ambiguous labels, duplicate usernames and malformed configuration without
echoing its contents. Actual practice labels remain in private configuration.

## Observed verification

- `npm run check` with the existing analysis virtual environment: PASS, 260 tests;
  229 passed, zero failed, 30 skipped, one TODO. Native PostgreSQL and opt-in live
  suites were not run by this command. All leakage scans passed.
- `npm run build`: PASS, seven manifests and 32 SQL inputs checked.
- Production browser checks in `tests/e2e/security-headers.spec.ts`: 3/3 PASS
  (name-selector submission and refusal, hosted navigation, nonce CSP/hydration).
  Selector/navigation checks use mocked Auth and do not establish remote security.
- Real new-project sign-in and authorization checks described above: PASS,
  separate from the mocked browser checks. Reports remain private.
- Changed-file formatting and `git diff --check`: PASS.

An initial lint run flagged a control-character regular expression; validation now
uses explicit character-code checks. An initial browser assertion matched Next's
accessibility announcer as well as the form error; it now targets the form alert.
Both checks were rerun successfully. No authorization assertion was removed.

## Illustrated guide

Seven-page PDF generated from actual served-browser screenshots on a separate
disposable local synthetic database. All three read-only examples displayed;
an answer survived reload, a second revision was recorded, and an adjudication
was saved. Those demonstration writes did not touch the shared practice queues.
Every PDF page was visually inspected, text extraction checked and actual account
passwords checked absent. The PDF contains no credentials or actual study data.

## Deployment boundary

The new project is prepared, but Render still needs its new practice environment
settings and the new application build. The Render settings file contains only
the publishable key, project/origin settings and explicitly public login labels.
It contains no admin key, database password, user password or private roster file.
New-project behavior through the public Render URL remains UNTESTED until that
switch and deployment are completed. Formal review remains disabled.
