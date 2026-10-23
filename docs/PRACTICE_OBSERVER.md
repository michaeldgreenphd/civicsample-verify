# View-only practice access

An investigator account can be restricted with `public.users.practice_read_only = true` by privileged administration. This is an access restriction, not a second study role. It requires migration 0031 and the corresponding web build. No account is changed by applying the migration alone.

A restricted account signs in with its existing username and password without a second factor for viewing practice. It can read aggregate completion counts and synthetic worked examples through `rpc_practice_observer_workspace`. It cannot approve gates, import, assign, adjudicate, submit answers, lock, export, manage accounts, or see individual reviewer judgments. Formal data is outside this mode. Existing Auth factors are preserved.

The database's investigator helper refuses restricted accounts even with an already-issued `aal2` token. Legacy effective-role checks receive `PRACTICE_OBSERVER`. The app also denies every non-session route except the read-only observer endpoint. Clients cannot remove their own restriction. Account locks and deactivation still deny access. Changes to the restriction are audited.

Deploy order: apply the additive migration to the authorized practice database; set the restriction on the specifically authorized account; deploy the web build. Earlier web builds continue requiring MFA until the new build is deployed. Full investigators still require MFA. Reversing the restriction restores full investigator privileges only with MFA and requires a separate authorized administrative action.
