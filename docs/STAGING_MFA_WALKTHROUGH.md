# Investigator second factor on staging — step by step

Who: the person operating the synthetic investigator account `syn-investigator-1` (you). What: enrol a TOTP authenticator through the application, so the staging session reaches assurance level 2 (`aal2`), which the database requires for every investigator action (`require_investigator_mfa`). Nothing here touches other accounts.

Terms: **TOTP** is the time-based six-digit code an authenticator app (for example a phone app) regenerates every thirty seconds; **aal1/aal2** are Supabase's assurance levels for a session (password only / password plus second factor).

## Before you start (local files, VS Code terminal)

1. The web app must be built from the branch under review and started in Supabase mode:
   `npm run build` then `npm run supabase:web -- start --config "$HOME/Private/civicsample-verify-staging/web-app.json" --port 3300`.
   The terminal prints `http://127.0.0.1:3300/`. The private file holds only the publishable key.
2. Have your authenticator app ready on your phone, and the synthetic investigator password from your private sign-in file (never paste it into chat).

## In the browser (http://127.0.0.1:3300/)

3. Username `syn-investigator-1`, password from the private file, **Sign in**. You land on the Supabase staging shell, which shows the panel **Second factor required for investigator actions**.
4. Click **Enrol an authenticator app**. A QR code and a text secret appear (the secret is yours; it is not stored by the application). Clicking again discards an unverified enrolment and issues a fresh secret, so an abandoned attempt is never left behind.
5. On your phone, add an account in the authenticator app by scanning the QR code (or typing the secret). The app shows a six-digit code.
6. Type the current code into **Six-digit code** and click **Verify code**. If it is refused, wait for the next code and check the phone's clock.
7. The panel disappears and the **Mapping confirmation** investigator console appears. The session is now `aal2`; the previous aal1 session was replaced by Supabase as part of verification.
8. Sign out with **Sign out**. Signing in again later lands on the second-factor panel with a single code field (no new enrolment and nothing else to type): enter the current code from your authenticator app and the investigator console returns.

## What this changes on staging

Only the Auth record of `syn-investigator-1` gains a verified TOTP factor. No schema change, no account creation, no data import.

## If something differs

Send a screenshot with the QR code and secret concealed; a secret that has appeared in a screenshot should be treated as spent and the factor re-enrolled. Lost authenticator: the privileged tool cannot remove a verified factor yet; this would be an investigator-authorized Auth Admin step to add.

Done on staging 2026-10-23: `syn-investigator-1` holds exactly one verified TOTP factor; no other account has a factor.
